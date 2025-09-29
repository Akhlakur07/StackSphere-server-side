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

        // Add timestamp and default values
        const productData = {
          ...product,
          votes: 0,
          status: "pending", // pending, accepted, rejected
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
