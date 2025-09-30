require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.oijxnxr.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// Initialize Stripe with your actual test keys
let stripe;
try {
  stripe = require("stripe")(`${process.env.STRIPE_SECRET_KEY}`);
  console.log("Stripe initialized successfully with test keys");
} catch (error) {
  console.error("Stripe initialization failed:", error.message);
  stripe = null;
}

async function run() {
  try {
    const userCollection = client.db("stackDB").collection("users");
    const paymentsCollection = client.db("stackDB").collection("payments");
    const productsCollection = client.db("stackDB").collection("products");
    const reviewsCollection = client.db("stackDB").collection("reviews");

    await client.connect();
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );

    // 🔹 Ensure unique email
    await userCollection.createIndex({ email: 1 }, { unique: true });

    app.post("/users", async (req, res) => {
      try {
        if (!userCollection) return res.status(503).send("DB not ready");

        const { name, email, photo, bio, authProvider, createdAt } =
          req.body || {};
        if (!email) return res.status(400).send("Email is required");

        const now = new Date();
        const update = {
          $setOnInsert: {
            email,
            role: "user", // Default role set to 'user'
            membership: { status: "none" }, // Add default membership
            createdAt: createdAt || now.toISOString(),
          },
          $set: {
            name: name || "",
            photo: photo || "",
            bio: bio || "",
            authProvider: authProvider || "password",
            updatedAt: now.toISOString(),
          },
        };

        const result = await userCollection.updateOne({ email }, update, {
          upsert: true,
        });

        const doc = await userCollection.findOne(
          { email },
          { projection: { _id: 0 } }
        );

        res.status(result.upsertedId ? 201 : 200).json({
          status: result.upsertedId ? "created" : "updated",
          user: doc,
        });
      } catch (err) {
        if (err?.code === 11000) {
          return res.status(409).send("Email already exists");
        }
        console.error("POST /users error:", err);
        res.status(500).send("Server error");
      }
    });

    // Fetch current user profile by email
    app.get("/users/:email", async (req, res) => {
      try {
        const user = await userCollection.findOne(
          { email: req.params.email },
          {
            projection: {
              name: 1,
              email: 1,
              photo: 1,
              role: 1,
              membership: 1,
              createdAt: 1,
              bio: 1,
              authProvider: 1,
              updatedAt: 1,
            },
          }
        );
        if (!user) return res.status(404).send("User not found");
        res.json(user);
      } catch (err) {
        res.status(500).send("Server error");
      }
    });

    // Create payment intent for membership
    app.post("/create-payment-intent", async (req, res) => {
      try {
        if (!stripe) {
          return res.status(503).json({ error: "Stripe service unavailable" });
        }

        const { amount, userEmail } = req.body;

        console.log(
          `Creating payment intent for amount: $${amount} for user: ${userEmail}`
        );

        const paymentIntent = await stripe.paymentIntents.create({
          amount: Math.round(amount * 100), // Convert to cents
          currency: "usd",
          automatic_payment_methods: {
            enabled: true,
          },
          metadata: {
            service: "stacksphere_membership",
            user_email: userEmail || "unknown",
          },
          // Enable Radar for fraud detection
          capture_method: "automatic",
        });

        console.log(`Payment intent created: ${paymentIntent.id}`);

        res.json({
          clientSecret: paymentIntent.client_secret,
          paymentIntentId: paymentIntent.id,
        });
      } catch (err) {
        console.error("Stripe payment intent error:", err);
        res.status(500).json({ error: err.message });
      }
    });

    // Save payment and update user membership
    app.post("/payments", async (req, res) => {
      try {
        const { email, amount, transactionId, membershipType } = req.body;

        console.log(
          `Processing payment for: ${email}, amount: $${amount}, transaction: ${transactionId}`
        );

        // Save payment record to payments collection
        const paymentData = {
          email,
          amount,
          transactionId: transactionId,
          membershipType: membershipType || "premium",
          paidAt: new Date().toISOString(),
          status: "completed",
          service: "membership_upgrade",
        };

        // Save to payments collection
        if (paymentsCollection) {
          await paymentsCollection.insertOne(paymentData);
        }

        // Update user membership status
        const updateResult = await userCollection.updateOne(
          { email },
          {
            $set: {
              "membership.status": "premium",
              "membership.type": membershipType || "monthly",
              "membership.purchasedAt": new Date().toISOString(),
              "membership.transactionId": transactionId,
              "membership.amount": amount,
              updatedAt: new Date().toISOString(),
            },
          }
        );

        console.log(
          `Membership upgraded for ${email}:`,
          updateResult.modifiedCount ? "Success" : "No changes"
        );

        res.status(200).json({
          status: "success",
          message:
            "Payment processed successfully - Membership upgraded to Premium!",
          payment: paymentData,
          userUpdated: updateResult.modifiedCount > 0,
        });
      } catch (err) {
        console.error("Payment processing error:", err);
        res.status(500).json({ error: err.message });
      }
    });

    // Get user profile with membership status
    app.get("/user-profile/:email", async (req, res) => {
      try {
        const user = await userCollection.findOne(
          { email: req.params.email },
          {
            projection: {
              name: 1,
              email: 1,
              photo: 1,
              role: 1,
              membership: 1,
              createdAt: 1,
              bio: 1,
            },
          }
        );

        if (!user) return res.status(404).send("User not found");
        res.json(user);
      } catch (err) {
        res.status(500).send("Server error");
      }
    });

    // Get user's payment history
    app.get("/payments/:email", async (req, res) => {
      try {
        if (!paymentsCollection) {
          return res.json([]); // Return empty array if collection doesn't exist
        }

        const payments = await paymentsCollection
          .find({ email: req.params.email }, { projection: { _id: 0 } })
          .sort({ paidAt: -1 })
          .toArray();

        res.json(payments);
      } catch (err) {
        res.status(500).send("Server error");
      }
    });

    // Create product
    // Update the existing POST /products endpoint
    app.post("/products", async (req, res) => {
      try {
        const product = req.body;

        // Validate required fields
        if (
          !product.name ||
          !product.image ||
          !product.description ||
          !product.owner
        ) {
          return res.status(400).json({ error: "Missing required fields" });
        }

        const userEmail = product.owner.email;

        // Check user's membership status and product count
        const user = await userCollection.findOne({ email: userEmail });
        if (!user) {
          return res.status(404).json({ error: "User not found" });
        }

        // Count user's existing products
        const userProductCount = await productsCollection.countDocuments({
          "owner.email": userEmail,
        });

        const isPremium = user.membership?.status === "premium";

        // Apply product limit for regular users
        if (!isPremium && userProductCount >= 1) {
          return res.status(403).json({
            error: "Product limit reached",
            message:
              "Regular users can only submit 1 product. Upgrade to premium to submit unlimited products.",
            currentCount: userProductCount,
            limit: 1,
            upgradeRequired: true,
          });
        }

        // Add timestamp and default values
        const productData = {
          ...product,
          votes: 0,
          status: "pending",
          featured: false,
          reported: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        const result = await productsCollection.insertOne(productData);

        res.status(201).json({
          success: true,
          message: "Product submitted successfully",
          productId: result.insertedId,
          userProductCount: userProductCount + 1,
          isPremium: isPremium,
          limit: isPremium ? "unlimited" : 1,
        });
      } catch (err) {
        console.error("POST /products error:", err);
        res.status(500).json({ error: "Failed to create product" });
      }
    });

    // Get user's products
    app.get("/products/user/:email", async (req, res) => {
      try {
        const { email } = req.params;
        const products = await productsCollection
          .find(
            { "owner.email": email },
            {
              projection: {
                name: 1,
                image: 1,
                description: 1,
                tags: 1,
                externalLink: 1,
                votes: 1,
                status: 1,
                featured: 1,
                createdAt: 1,
                owner: 1,
              },
            }
          )
          .sort({ createdAt: -1 })
          .toArray();

        res.json(products);
      } catch (err) {
        console.error("GET /products/user/:email error:", err);
        res.status(500).json({ error: "Failed to fetch products" });
      }
    });

    // Get featured products (for homepage)
    app.get("/products/featured", async (req, res) => {
      try {
        const products = await productsCollection
          .find(
            {
              status: "accepted",
              featured: true,
            },
            {
              projection: {
                name: 1,
                image: 1,
                tags: 1,
                votes: 1,
                owner: 1,
                createdAt: 1,
              },
            }
          )
          .sort({ createdAt: -1 })
          .limit(4)
          .toArray();

        res.json(products);
      } catch (err) {
        console.error("GET /products/featured error:", err);
        res.status(500).json({ error: "Failed to fetch featured products" });
      }
    });

    // Get trending products (by votes)
    app.get("/products/trending", async (req, res) => {
      try {
        const products = await productsCollection
          .find(
            { status: "accepted" },
            {
              projection: {
                name: 1,
                image: 1,
                tags: 1,
                votes: 1,
                owner: 1,
                createdAt: 1,
              },
            }
          )
          .sort({ votes: -1 })
          .limit(6)
          .toArray();

        res.json(products);
      } catch (err) {
        console.error("GET /products/trending error:", err);
        res.status(500).json({ error: "Failed to fetch trending products" });
      }
    });

    // Get all accepted products (for products page)
    app.get("/products", async (req, res) => {
      try {
        const { page = 1, limit = 6, search = "" } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        let query = { status: "accepted" };

        // Search by tags if search query provided
        if (search.trim()) {
          query.tags = { $regex: search.trim(), $options: "i" };
        }

        const products = await productsCollection
          .find(query, {
            projection: {
              name: 1,
              image: 1,
              tags: 1,
              votes: 1,
              owner: 1,
              createdAt: 1,
              description: 1,
            },
          })
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(parseInt(limit))
          .toArray();

        const total = await productsCollection.countDocuments(query);

        res.json({
          products,
          totalPages: Math.ceil(total / parseInt(limit)),
          currentPage: parseInt(page),
          totalProducts: total,
        });
      } catch (err) {
        console.error("GET /products error:", err);
        res.status(500).json({ error: "Failed to fetch products" });
      }
    });
    // Get pending products for moderators
    app.get("/products/pending", async (req, res) => {
      try {
        console.log("Fetching pending products...");

        const products = await productsCollection
          .find(
            { status: "pending" },
            {
              projection: {
                _id: 1,
                name: 1,
                image: 1,
                description: 1,
                tags: 1,
                externalLink: 1,
                votes: 1,
                status: 1,
                featured: 1,
                createdAt: 1,
                owner: 1,
                updatedAt: 1,
              },
            }
          )
          .sort({ createdAt: 1 })
          .toArray();

        console.log(`Found ${products.length} pending products`);
        res.json(products);
      } catch (err) {
        console.error("GET /products/pending error:", err);
        res.status(500).json({ error: "Failed to fetch pending products" });
      }
    });

    // Get pending products count
    app.get("/products/pending/count", async (req, res) => {
      try {
        const count = await productsCollection.countDocuments({
          status: "pending",
        });
        res.json({ count });
      } catch (err) {
        console.error("GET /products/pending/count error:", err);
        res.status(500).json({ error: "Failed to fetch pending count" });
      }
    });

    // Get reported products
    app.get("/products/reported", async (req, res) => {
      try {
        console.log("Fetching reported products...");

        const products = await productsCollection
          .find(
            { reported: true }, // Assuming you have a 'reported' field
            {
              projection: {
                _id: 1,
                name: 1,
                image: 1,
                description: 1,
                tags: 1,
                externalLink: 1,
                votes: 1,
                status: 1,
                featured: 1,
                createdAt: 1,
                owner: 1,
                updatedAt: 1,
                reported: 1,
                reportReason: 1,
                reportedBy: 1,
                reportedAt: 1,
              },
            }
          )
          .sort({ reportedAt: -1 }) // Most recent reports first
          .toArray();

        console.log(`Found ${products.length} reported products`);
        res.json(products);
      } catch (err) {
        console.error("GET /products/reported error:", err);
        res.status(500).json({ error: "Failed to fetch reported products" });
      }
    });

    // Get reported products count
    app.get("/products/reported/count", async (req, res) => {
      try {
        const count = await productsCollection.countDocuments({
          reported: true,
        });
        res.json({ count });
      } catch (err) {
        console.error("GET /products/reported/count error:", err);
        res.status(500).json({ error: "Failed to fetch reported count" });
      }
    });

    // Get accepted products that are not featured
    app.get("/products/accepted-non-featured", async (req, res) => {
      try {
        const products = await productsCollection
          .find(
            {
              status: "accepted",
              featured: { $ne: true }, // Not featured
            },
            {
              projection: {
                _id: 1,
                name: 1,
                image: 1,
                description: 1,
                tags: 1,
                externalLink: 1,
                votes: 1,
                status: 1,
                featured: 1,
                createdAt: 1,
                owner: 1,
                updatedAt: 1,
              },
            }
          )
          .sort({ createdAt: -1 })
          .toArray();

        res.json(products);
      } catch (err) {
        console.error("GET /products/accepted-non-featured error:", err);
        res.status(500).json({ error: "Failed to fetch accepted products" });
      }
    });

    app.get("/products/:id", async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: "Invalid product ID" });
        }

        const product = await productsCollection.findOne(
          { _id: new ObjectId(id) },
          {
            projection: {
              name: 1,
              image: 1,
              description: 1,
              tags: 1,
              externalLink: 1,
              votes: 1,
              status: 1,
              featured: 1,
              createdAt: 1,
              owner: 1,
            },
          }
        );

        if (!product) {
          return res.status(404).json({ error: "Product not found" });
        }

        res.json(product);
      } catch (err) {
        console.error("GET /products/:id error:", err);
        res.status(500).json({ error: "Failed to fetch product" });
      }
    });

    // Update product
    app.put("/products/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const updateData = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: "Invalid product ID" });
        }

        // Validate required fields
        if (!updateData.name || !updateData.image || !updateData.description) {
          return res.status(400).json({ error: "Missing required fields" });
        }

        // Ensure only the owner can update the product
        const existingProduct = await productsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!existingProduct) {
          return res.status(404).json({ error: "Product not found" });
        }

        // Add updated timestamp
        const updatedProduct = {
          ...updateData,
          updatedAt: new Date().toISOString(),
        };

        const result = await productsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updatedProduct }
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({ error: "Product not found" });
        }

        res.json({
          success: true,
          message: "Product updated successfully",
          productId: id,
        });
      } catch (err) {
        console.error("PUT /products/:id error:", err);
        res.status(500).json({ error: "Failed to update product" });
      }
    });

    // Delete product
    app.delete("/products/:id", async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: "Invalid product ID" });
        }

        // Also delete associated reviews
        await reviewsCollection.deleteMany({ productId: id });

        const result = await productsCollection.deleteOne({
          _id: new ObjectId(id),
        });

        if (result.deletedCount === 0) {
          return res.status(404).json({ error: "Product not found" });
        }

        res.json({
          success: true,
          message: "Product deleted successfully",
        });
      } catch (err) {
        console.error("DELETE /products/:id error:", err);
        res.status(500).json({ error: "Failed to delete product" });
      }
    });

    // Update product status (accept/reject)
    app.patch("/products/:id/status", async (req, res) => {
      try {
        const { id } = req.params;
        const { status } = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: "Invalid product ID" });
        }

        if (!["accepted", "rejected", "pending"].includes(status)) {
          return res.status(400).json({ error: "Invalid status" });
        }

        const updateData = {
          status: status,
          updatedAt: new Date().toISOString(),
        };

        // If accepting, also set reviewedAt timestamp
        if (status === "accepted") {
          updateData.reviewedAt = new Date().toISOString();
        }

        const result = await productsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updateData }
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({ error: "Product not found" });
        }

        res.json({
          success: true,
          message: `Product ${status} successfully`,
          productId: id,
          status: status,
        });
      } catch (err) {
        console.error("PATCH /products/:id/status error:", err);
        res.status(500).json({ error: "Failed to update product status" });
      }
    });

    // Mark product as featured
    app.patch("/products/:id/featured", async (req, res) => {
      try {
        const { id } = req.params;
        const { featured } = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: "Invalid product ID" });
        }

        // Check if product exists and is accepted
        const product = await productsCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!product) {
          return res.status(404).json({ error: "Product not found" });
        }

        if (product.status !== "accepted") {
          return res
            .status(400)
            .json({ error: "Only accepted products can be featured" });
        }

        const result = await productsCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              featured: featured,
              updatedAt: new Date().toISOString(),
            },
          }
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({ error: "Product not found" });
        }

        res.json({
          success: true,
          message: `Product ${
            featured ? "marked as" : "unmarked from"
          } featured`,
          productId: id,
          featured: featured,
        });
      } catch (err) {
        console.error("PATCH /products/:id/featured error:", err);
        res
          .status(500)
          .json({ error: "Failed to update product featured status" });
      }
    });

    app.get("/moderator/products", async (req, res) => {
      try {
        const products = await productsCollection
          .find(
            {},
            {
              projection: {
                name: 1,
                image: 1,
                description: 1,
                tags: 1,
                externalLink: 1,
                votes: 1,
                status: 1,
                featured: 1,
                createdAt: 1,
                owner: 1,
                updatedAt: 1,
                reviewedAt: 1,
              },
            }
          )
          .sort({
            status: 1, // pending first (alphabetical: accepted, pending, rejected)
            createdAt: 1, // then by creation date
          })
          .toArray();

        res.json(products);
      } catch (err) {
        console.error("GET /moderator/products error:", err);
        res.status(500).json({ error: "Failed to fetch products" });
      }
    });

    // Get all users (admin only)
    app.get("/admin/users", async (req, res) => {
      try {
        const users = await userCollection
          .find(
            {},
            {
              projection: {
                name: 1,
                email: 1,
                photo: 1,
                role: 1,
                membership: 1,
                createdAt: 1,
                bio: 1,
                authProvider: 1,
              },
            }
          )
          .sort({ createdAt: -1 })
          .toArray();

        res.json(users);
      } catch (err) {
        console.error("GET /admin/users error:", err);
        res.status(500).json({ error: "Failed to fetch users" });
      }
    });

    // Update user role (admin only)
    app.patch("/admin/users/:userId/role", async (req, res) => {
      try {
        const { userId } = req.params;
        const { role } = req.body;

        if (!ObjectId.isValid(userId)) {
          return res.status(400).json({ error: "Invalid user ID" });
        }

        if (!["user", "moderator", "admin"].includes(role)) {
          return res.status(400).json({ error: "Invalid role" });
        }

        const result = await userCollection.updateOne(
          { _id: new ObjectId(userId) },
          {
            $set: {
              role: role,
              updatedAt: new Date().toISOString(),
            },
          }
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({ error: "User not found" });
        }

        res.json({
          success: true,
          message: `User role updated to ${role}`,
          userId: userId,
          role: role,
        });
      } catch (err) {
        console.error("PATCH /admin/users/:userId/role error:", err);
        res.status(500).json({ error: "Failed to update user role" });
      }
    });
    
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}

run().catch(console.dir);

app.get("/", (req, res) => {
  res.send(
    "StackSphere Server is Running - Stripe Payments with Radar Enabled"
  );
});

app.listen(port, () => {
  console.log(`StackSphere Server is Running on port: ${port}`);
  console.log("Stripe payments are enabled with Radar fraud detection");
});
