## StackSphere Backend (StackVault)

Backend API for StackSphere, powering user accounts, products, reviews, coupons, and payments. Built with Express and MongoDB. Stripe is used for membership payments.

### Live Site

- Frontend: [stack-web-6def0.web.app](https://stack-web-6def0.web.app/)

### Tech Stack

- Node.js, Express (CommonJS)
- MongoDB (official Node driver)
- Stripe
- CORS, dotenv

### Features

- User upsert and profile retrieval
- Product submission with membership-based limits (premium vs regular)
- Product discovery: featured, trending, search, pagination
- Moderator/admin utilities: review queue, role management, statistics
- Reviews CRUD (create + list by product)
- Coupons: create, update, delete, validate, usage tracking
- Stripe payment intent creation and membership upgrade tracking

### Prerequisites

- Node.js 18+
- A MongoDB Atlas cluster
- Stripe account (test keys are fine during development)

### Environment Variables

Create a `.env` file in the project root with:

```
PORT=3000
DB_USER=yourMongoUser
DB_PASS=yourMongoPassword
STRIPE_SECRET_KEY=sk_test_xxx
```

MongoDB URI is constructed as:
`mongodb+srv://${DB_USER}:${DB_PASS}@cluster0.oijxnxr.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`

### Install & Run

```
npm install
node index.js
```

Server starts on `http://localhost:3000` by default.

### CORS Origins (allowed)

- `http://localhost:5173`
- `http://127.0.0.1:5173`
- `http://localhost:3000`
- `https://stack-web-6def0.web.app`
- `https://stack-web-6def0.firebaseapp.com/`

### Health Check

```
GET /test
```

Response example:

```
{
  "message": "Backend is working!",
  "timestamp": "2025-01-01T00:00:00.000Z",
  "database": "Connected to MongoDB"
}
```

### API Overview

Users

- `POST /users` — Upsert user by email
- `GET /users/:email` — Get user profile
- `GET /user-profile/:email` — Profile with membership

Payments & Membership

- `POST /create-payment-intent` — Create Stripe PaymentIntent
- `POST /payments` — Record payment and upgrade membership

Products

- `POST /products` — Create (limits for regular users)
- `GET /products` — List accepted products with `page`, `limit`, `search`
- `GET /products/featured` — Featured products
- `GET /products/trending` — Trending by votes
- `GET /products/pending` — Pending list (moderation)
- `GET /products/pending/count` — Pending count
- `GET /products/reported` — Reported products
- `GET /products/reported/count` — Reported count
- `GET /products/accepted-non-featured` — Accepted but not featured
- `GET /products/user/:email` — Products by owner
- `GET /products/:id` — Single product
- `PUT /products/:id` — Update product
- `DELETE /products/:id` — Delete product (also deletes reviews)
- `PATCH /products/:id/status` — Accept/Reject/Pending
- `PATCH /products/:id/featured` — Mark/unmark as featured
- `POST /products/:id/upvote` — Upvote
- `POST /products/:id/report` — Report

Reviews

- `GET /reviews/product/:productId` — List reviews for a product
- `POST /reviews` — Create review

Admin

- `GET /admin/users` — List users
- `PATCH /admin/users/:userId/role` — Update role (`user|moderator|admin`)
- `GET /admin/statistics` — Dashboard counts; optional `?range=all|month|week`

Coupons (Admin)

- `GET /admin/coupons` — List coupons
- `POST /admin/coupons` — Create coupon
- `PUT /admin/coupons/:id` — Update coupon
- `DELETE /admin/coupons/:id` — Delete coupon
- `GET /coupons/validate/:code` — Validate coupon for checkout
- `POST /coupons/use/:code` — Increment coupon usage

### Notes

- Root route: `GET /` returns "StackVault Server is Running".
- Ensure your Stripe secret key is loaded; the server handles absence gracefully but payment endpoints will be unavailable.
