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

async function run() {
  try {
    const userCollection = client.db("stackDB").collection("users");

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
        const user = await userCollection.findOne({ email: req.params.email });
        if (!user) return res.status(404).send("Not found");
        res.json(user);
      } catch (err) {
        res.status(500).send("Server error");
      }
    });
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}

run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("StackSphere Server is Running");
});

app.listen(port, () => {
  console.log(`StackSphere Server is Running on port: ${port}`);
});