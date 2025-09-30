require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const app = express();
const port = process.env.PORT || 3000;

// CORS & middleware
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://localhost:3000",
      "https://stack-web-6def0.web.app",
      "https://stack-web-6def0.firebaseapp.com/",
    ],
    credentials: true,
  })
);
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
    const couponsCollection = client.db("stackDB").collection("coupons");

    // await client.connect();
    // await client.db("admin").command({ ping: 1 });
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

        const { amount, userEmail, couponCode } = req.body;

        console.log(
          `Creating payment intent for amount: $${amount} for user: ${userEmail}${
            couponCode ? ` with coupon: ${couponCode}` : ""
          }`
        );

        const paymentIntent = await stripe.paymentIntents.create({
          amount: Math.round(amount * 100), // Convert to cents
          currency: "usd",
          automatic_payment_methods: {
            enabled: true,
          },
          metadata: {
            service: "StackVault_membership",
            user_email: userEmail || "unknown",
            coupon_code: couponCode || "none",
          },
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

    // Get all accepted products (for products page) - Updated with enhanced search
    app.get("/products", async (req, res) => {
      try {
        const { page = 1, limit = 6, search = "" } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);

        let query = { status: "accepted" };

        // Enhanced search: Search by tags OR product name OR description
        if (search.trim()) {
          const searchRegex = { $regex: search.trim(), $options: "i" };
          query.$or = [
            { tags: searchRegex },
            { name: searchRegex },
            { description: searchRegex },
          ];
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
              featured: 1,
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

    // Get admin statistics
    app.get("/admin/statistics", async (req, res) => {
      try {
        const { range = "all" } = req.query;

        // Calculate date range
        let startDate = new Date("2020-01-01"); // All time
        if (range === "month") {
          startDate = new Date();
          startDate.setMonth(startDate.getMonth() - 1);
        } else if (range === "week") {
          startDate = new Date();
          startDate.setDate(startDate.getDate() - 7);
        }

        // Get product statistics
        const totalProducts = await productsCollection.countDocuments({
          createdAt: { $gte: startDate.toISOString() },
        });
        const acceptedProducts = await productsCollection.countDocuments({
          status: "accepted",
          createdAt: { $gte: startDate.toISOString() },
        });
        const pendingProducts = await productsCollection.countDocuments({
          status: "pending",
          createdAt: { $gte: startDate.toISOString() },
        });
        const rejectedProducts = await productsCollection.countDocuments({
          status: "rejected",
          createdAt: { $gte: startDate.toISOString() },
        });

        // Get user statistics
        const totalUsers = await userCollection.countDocuments({
          createdAt: { $gte: startDate.toISOString() },
        });
        const premiumUsers = await userCollection.countDocuments({
          "membership.status": "premium",
          createdAt: { $gte: startDate.toISOString() },
        });
        const regularUsers = totalUsers - premiumUsers;

        // Get review statistics
        const totalReviews = await reviewsCollection.countDocuments({
          createdAt: { $gte: startDate.toISOString() },
        });

        // Get revenue statistics (you'll need to implement this based on your payments collection)
        const revenueData = await paymentsCollection
          .aggregate([
            {
              $match: {
                paidAt: { $gte: startDate.toISOString() },
                status: "completed",
              },
            },
            {
              $group: {
                _id: null,
                totalRevenue: { $sum: "$amount" },
              },
            },
          ])
          .toArray();

        const totalRevenue =
          revenueData.length > 0 ? revenueData[0].totalRevenue : 0;

        res.json({
          products: {
            accepted: acceptedProducts,
            pending: pendingProducts,
            rejected: rejectedProducts,
            total: totalProducts,
          },
          users: {
            total: totalUsers,
            premium: premiumUsers,
            regular: regularUsers,
          },
          reviews: {
            total: totalReviews,
          },
          revenue: {
            total: totalRevenue,
            monthly: totalRevenue,
          },
        });
      } catch (err) {
        console.error("GET /admin/statistics error:", err);
        res.status(500).json({ error: "Failed to fetch statistics" });
      }
    });

    // Get all coupons
    app.get("/admin/coupons", async (req, res) => {
      try {
        const coupons = await couponsCollection
          .find({})
          .sort({ createdAt: -1 })
          .toArray();

        res.json(coupons);
      } catch (err) {
        console.error("GET /admin/coupons error:", err);
        res.status(500).json({ error: "Failed to fetch coupons" });
      }
    });

    // Create new coupon
    app.post("/admin/coupons", async (req, res) => {
      try {
        const {
          code,
          description,
          discountAmount,
          expiryDate,
          maxUses,
          minOrderAmount,
          isActive,
        } = req.body;

        // Validate required fields
        if (!code || !description || !discountAmount || !expiryDate) {
          return res.status(400).json({ error: "Missing required fields" });
        }

        // Check if coupon code already exists
        const existingCoupon = await couponsCollection.findOne({
          code: code.toUpperCase(),
        });
        if (existingCoupon) {
          return res.status(409).json({ error: "Coupon code already exists" });
        }

        const couponData = {
          code: code.toUpperCase(),
          description,
          discountAmount: parseFloat(discountAmount),
          expiryDate: new Date(expiryDate).toISOString(),
          maxUses: maxUses ? parseInt(maxUses) : null,
          minOrderAmount: minOrderAmount ? parseFloat(minOrderAmount) : null,
          isActive: isActive !== undefined ? isActive : true,
          usedCount: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        const result = await couponsCollection.insertOne(couponData);

        res.status(201).json({
          success: true,
          message: "Coupon created successfully",
          couponId: result.insertedId,
          coupon: couponData,
        });
      } catch (err) {
        console.error("POST /admin/coupons error:", err);
        res.status(500).json({ error: "Failed to create coupon" });
      }
    });

    // Update coupon
    app.put("/admin/coupons/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const {
          code,
          description,
          discountAmount,
          expiryDate,
          maxUses,
          minOrderAmount,
          isActive,
        } = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: "Invalid coupon ID" });
        }

        // Validate required fields
        if (!code || !description || !discountAmount || !expiryDate) {
          return res.status(400).json({ error: "Missing required fields" });
        }

        // Check if coupon code already exists (excluding current coupon)
        const existingCoupon = await couponsCollection.findOne({
          code: code.toUpperCase(),
          _id: { $ne: new ObjectId(id) },
        });
        if (existingCoupon) {
          return res.status(409).json({ error: "Coupon code already exists" });
        }

        const updateData = {
          code: code.toUpperCase(),
          description,
          discountAmount: parseFloat(discountAmount),
          expiryDate: new Date(expiryDate).toISOString(),
          maxUses: maxUses ? parseInt(maxUses) : null,
          minOrderAmount: minOrderAmount ? parseFloat(minOrderAmount) : null,
          isActive: isActive !== undefined ? isActive : true,
          updatedAt: new Date().toISOString(),
        };

        const result = await couponsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updateData }
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({ error: "Coupon not found" });
        }

        res.json({
          success: true,
          message: "Coupon updated successfully",
          couponId: id,
        });
      } catch (err) {
        console.error("PUT /admin/coupons/:id error:", err);
        res.status(500).json({ error: "Failed to update coupon" });
      }
    });

    // Delete coupon
    app.delete("/admin/coupons/:id", async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: "Invalid coupon ID" });
        }

        const result = await couponsCollection.deleteOne({
          _id: new ObjectId(id),
        });

        if (result.deletedCount === 0) {
          return res.status(404).json({ error: "Coupon not found" });
        }

        res.json({
          success: true,
          message: "Coupon deleted successfully",
        });
      } catch (err) {
        console.error("DELETE /admin/coupons/:id error:", err);
        res.status(500).json({ error: "Failed to delete coupon" });
      }
    });

    // Validate coupon (for payment page - you'll need this later)
    app.get("/coupons/validate/:code", async (req, res) => {
      try {
        const { code } = req.params;
        const coupon = await couponsCollection.findOne({
          code: code.toUpperCase(),
        });

        if (!coupon) {
          return res.status(404).json({ error: "Coupon not found" });
        }

        const now = new Date();
        const expiryDate = new Date(coupon.expiryDate);

        if (!coupon.isActive) {
          return res.status(400).json({ error: "Coupon is not active" });
        }

        if (expiryDate < now) {
          return res.status(400).json({ error: "Coupon has expired" });
        }

        if (coupon.maxUses && coupon.usedCount >= coupon.maxUses) {
          return res.status(400).json({ error: "Coupon usage limit reached" });
        }

        res.json({
          valid: true,
          coupon: {
            code: coupon.code,
            description: coupon.description,
            discountAmount: coupon.discountAmount,
            minOrderAmount: coupon.minOrderAmount,
          },
        });
      } catch (err) {
        console.error("GET /coupons/validate/:code error:", err);
        res.status(500).json({ error: "Failed to validate coupon" });
      }
    });
    app.post("/coupons/use/:code", async (req, res) => {
      try {
        const { code } = req.params;

        const result = await couponsCollection.updateOne(
          { code: code.toUpperCase() },
          {
            $inc: { usedCount: 1 },
            $set: { updatedAt: new Date().toISOString() },
          }
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({ error: "Coupon not found" });
        }

        res.json({
          success: true,
          message: "Coupon usage updated",
        });
      } catch (err) {
        console.error("POST /coupons/use/:code error:", err);
        res.status(500).json({ error: "Failed to update coupon usage" });
      }
    });

    // Add to your backend server

    // Upvote a product
    app.post("/products/:id/upvote", async (req, res) => {
      try {
        const { id } = req.params;
        const { userEmail } = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: "Invalid product ID" });
        }

        // Check if user has already upvoted (you might want to track this)
        const product = await productsCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!product) {
          return res.status(404).json({ error: "Product not found" });
        }

        // Increment votes
        const result = await productsCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $inc: { votes: 1 },
            $set: { updatedAt: new Date().toISOString() },
          }
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({ error: "Product not found" });
        }

        // Return updated product
        const updatedProduct = await productsCollection.findOne(
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

        res.json(updatedProduct);
      } catch (err) {
        console.error("POST /products/:id/upvote error:", err);
        res.status(500).json({ error: "Failed to upvote product" });
      }
    });

    // Report a product
    app.post("/products/:id/report", async (req, res) => {
      try {
        const { id } = req.params;
        const { userEmail, userName, userPhoto } = req.body; // ✅ Add userPhoto to destructuring

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ error: "Invalid product ID" });
        }

        const result = await productsCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              reported: true,
              reportedBy: userEmail,
              reporterName: userName,
              reporterImage: userPhoto || "", // ✅ Use userPhoto with fallback
              reportedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          }
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({ error: "Product not found" });
        }

        res.json({ success: true, message: "Product reported successfully" });
      } catch (err) {
        console.error("POST /products/:id/report error:", err);
        res.status(500).json({ error: "Failed to report product" });
      }
    });

    // Get reviews for a product
    app.get("/reviews/product/:productId", async (req, res) => {
      try {
        const { productId } = req.params;

        const reviews = await reviewsCollection
          .find(
            { productId: productId },
            {
              projection: {
                _id: 1,
                reviewerName: 1,
                reviewerImage: 1,
                description: 1,
                rating: 1,
                createdAt: 1,
              },
            }
          )
          .sort({ createdAt: -1 })
          .toArray();

        res.json(reviews);
      } catch (err) {
        console.error("GET /reviews/product/:productId error:", err);
        res.status(500).json({ error: "Failed to fetch reviews" });
      }
    });

    // Create a review
    app.post("/reviews", async (req, res) => {
      try {
        const review = req.body;

        // Validate required fields
        if (!review.productId || !review.description || !review.rating) {
          return res.status(400).json({ error: "Missing required fields" });
        }

        const reviewData = {
          ...review,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        const result = await reviewsCollection.insertOne(reviewData);

        res.status(201).json({
          ...reviewData,
          _id: result.insertedId,
        });
      } catch (err) {
        console.error("POST /reviews error:", err);
        res.status(500).json({ error: "Failed to create review" });
      }
    });

    app.get("/test", (req, res) => {
      res.json({
        message: "Backend is working!",
        timestamp: new Date().toISOString(),
        database: "Connected to MongoDB",
      });
    });
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}

run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("StackVault Server is Running");
});

app.listen(port, () => {
  console.log(`StackVault Server is Running on port: ${port}`);
});
