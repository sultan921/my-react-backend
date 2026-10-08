const express = require("express");



const crypto = require("crypto");







const http = require("http");



const { Server } = require("socket.io");



const mongoose = require("mongoose");



const cors = require("cors");



require("dotenv").config();







const app = express();



const server = http.createServer(app);







// ==========================



// Socket.io Setup



// ==========================







const io = new Server(server, {



  cors: {



    origin: "*",



    methods: ["GET", "POST"]



  }



});







// ==========================



// Middleware



// ==========================







app.use(express.json());



app.use(cors());







// ==========================



// Environment Variables & Port



// ==========================







const PORT = process.env.PORT || 8080;



const MONGO_URI = process.env.MONGO_URI;







// ==========================



// MongoDB Connection



// ==========================







mongoose



  .connect(MONGO_URI)



  .then(() => {



    console.log("✅ Successfully connected to MongoDB Atlas");



  })



  .catch((err) => {



    console.error("❌ MongoDB Connection Error:", err.message);



    process.exit(1);



  });







// ==========================



// User Schema & Model



// ==========================







const userSchema = new mongoose.Schema({



  name: {



    type: String,



    required: true



  },







  phone: {



    type: String,



    required: true,



    unique: true



  },







  password: {



    type: String,



    required: true



  },







  coins: {



    type: Number,



    default: 0



  }



});







const User = mongoose.model("User", userSchema);


// ======================================================
// WALLET DEPOSIT SYSTEM - STEP 1 TO STEP 6
// ======================================================
//
// Flow:
// 1) User submits Easypaisa/JazzCash deposit.
// 2) Backend calculates coins. Frontend cannot choose coins.
// 3) Deposit remains "pending" until verified.
// 4) Admin approves a genuine payment.
// 5) Coins are credited exactly once inside a MongoDB transaction.
// 6) Fake/invalid payment can be rejected and gives 0 coins.
//
// Current conversion:
// Rs. 50 = 2,000 coins  =>  1 PKR = 40 coins
// ======================================================

const COINS_PER_PKR = 40;
const MIN_DEPOSIT_PKR = 10;
const MAX_DEPOSIT_PKR = 100000;

function calculateDepositCoins(amountPKR) {
  const amount = Number(amountPKR);

  if (!Number.isFinite(amount)) {
    return 0;
  }

  return Math.floor(amount * COINS_PER_PKR);
}

function normalizeTransactionId(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

const depositSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },

    amountPKR: {
      type: Number,
      required: true,
      min: MIN_DEPOSIT_PKR,
      max: MAX_DEPOSIT_PKR
    },

    coinsToCredit: {
      type: Number,
      required: true,
      min: 1
    },

    method: {
      type: String,
      enum: ["easypaisa", "jazzcash"],
      required: true,
      index: true
    },

    transactionId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
      uppercase: true
    },

    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
      index: true
    },

    submittedAt: {
      type: Date,
      default: Date.now
    },

    approvedAt: {
      type: Date,
      default: null
    },

    rejectedAt: {
      type: Date,
      default: null
    },

    creditedAt: {
      type: Date,
      default: null
    },

    rejectionReason: {
      type: String,
      default: ""
    }
  },
  {
    timestamps: true
  }
);

const Deposit =
  mongoose.models.Deposit ||
  mongoose.model("Deposit", depositSchema);


// ======================================================
// REAL NOTIFICATION CENTER - PERSISTENT + REALTIME
// ======================================================

const appNotificationSchema = new mongoose.Schema(
  {
    recipientUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    senderUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true
    },
    senderName: {
      type: String,
      default: "",
      trim: true,
      maxlength: 120
    },
    type: {
      type: String,
      enum: [
        "friend_request",
        "friend_response",
        "challenge",
        "challenge_accepted",
        "challenge_rejected",
        "deposit_approved",
        "deposit_rejected",
        "admin_message",
        "message",
        "system"
      ],
      default: "system",
      index: true
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120
    },
    message: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1200
    },
    data: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    read: {
      type: Boolean,
      default: false,
      index: true
    },
    actionStatus: {
      type: String,
      enum: ["none", "pending", "accepted", "rejected", "opened"],
      default: "none",
      index: true
    },
    sourceKey: {
      type: String,
      default: "",
      trim: true,
      index: true
    }
  },
  {
    timestamps: true
  }
);

appNotificationSchema.index({
  recipientUserId: 1,
  createdAt: -1
});

const AppNotification =
  mongoose.models.AppNotification ||
  mongoose.model("AppNotification", appNotificationSchema);

const friendshipSchema = new mongoose.Schema(
  {
    pairKey: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    users: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true
      }
    ],
    acceptedAt: {
      type: Date,
      default: Date.now
    }
  },
  {
    timestamps: true
  }
);

const Friendship =
  mongoose.models.Friendship ||
  mongoose.model("Friendship", friendshipSchema);

function notificationRoom(userId) {
  return `notifications:${String(userId || "")}`;
}

function serializeNotification(notification) {
  const item =
    typeof notification?.toObject === "function"
      ? notification.toObject()
      : notification || {};

  return {
    id: String(item._id || item.id || ""),
    recipientUserId: String(item.recipientUserId || ""),
    senderUserId: item.senderUserId ? String(item.senderUserId) : "",
    senderName: item.senderName || "",
    type: item.type || "system",
    title: item.title || "Notification",
    message: item.message || "",
    data: item.data || {},
    read: Boolean(item.read),
    actionStatus: item.actionStatus || "none",
    sourceKey: item.sourceKey || "",
    createdAt: item.createdAt || new Date().toISOString(),
    updatedAt: item.updatedAt || item.createdAt || new Date().toISOString()
  };
}

async function createAndPushNotification({
  recipientUserId,
  senderUserId = null,
  senderName = "",
  type = "system",
  title,
  message,
  data = {},
  actionStatus = "none",
  sourceKey = ""
}) {
  if (
    !recipientUserId ||
    !mongoose.Types.ObjectId.isValid(String(recipientUserId))
  ) {
    return null;
  }

  const notification = await AppNotification.create({
    recipientUserId,
    senderUserId:
      senderUserId &&
      mongoose.Types.ObjectId.isValid(String(senderUserId))
        ? senderUserId
        : null,
    senderName: String(senderName || "").slice(0, 120),
    type,
    title: String(title || "Notification").slice(0, 120),
    message: String(message || "").slice(0, 1200),
    data,
    read: false,
    actionStatus,
    sourceKey: String(sourceKey || "").slice(0, 300)
  });

  const payload = serializeNotification(notification);

  io.to(notificationRoom(recipientUserId)).emit(
    "notification:new",
    payload
  );

  return payload;
}

function canonicalFriendPair(userA, userB) {
  return [String(userA), String(userB)].sort().join(":");
}


// ------------------------------------------------------
// ADMIN SECURITY - PRIVATE BACKEND TOKEN SYSTEM
// ------------------------------------------------------
// Railway Variables:
// ADMIN_PHONE=registered SAMATKAAR admin phone
// ADMIN_DEPOSIT_KEY=long private signing secret
//
// Secret key stays only on Railway/backend.
// Browser receives only a short-lived signed admin token.
// ------------------------------------------------------

const ADMIN_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
const ADMIN_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const ADMIN_LOGIN_MAX_FAILURES = 5;
const adminLoginAttempts = new Map();

function normalizeAdminPhone(value) {
  let phone = String(value || "").replace(/\D/g, "");

  if (phone.startsWith("0092")) {
    phone = phone.slice(2);
  }

  if (phone.startsWith("92") && phone.length === 12) {
    phone = `0${phone.slice(2)}`;
  }

  return phone;
}

function isAdminPhone(phone) {
  const configuredAdminPhone = normalizeAdminPhone(
    process.env.ADMIN_PHONE
  );

  if (!configuredAdminPhone) {
    return false;
  }

  return normalizeAdminPhone(phone) === configuredAdminPhone;
}

function getAdminSigningSecret() {
  return String(process.env.ADMIN_DEPOSIT_KEY || "");
}

const USER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function getUserSessionSecret() {
  // USER_SESSION_SECRET is preferred. ADMIN_DEPOSIT_KEY is a compatibility
  // fallback so the persistence fix works immediately with the current Railway setup.
  return String(
    process.env.USER_SESSION_SECRET ||
    process.env.ADMIN_DEPOSIT_KEY ||
    ""
  );
}

function createUserSessionToken(user) {
  const secret = getUserSessionSecret();

  if (!secret) {
    throw new Error(
      "USER_SESSION_SECRET ya ADMIN_DEPOSIT_KEY server par configure nahi hai."
    );
  }

  const payload = {
    sub: String(user._id),
    phone: String(user.phone || ""),
    exp: Date.now() + USER_SESSION_TTL_MS
  };

  const encodedPayload = Buffer.from(
    JSON.stringify(payload)
  ).toString("base64url");

  const signature = crypto
    .createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");

  return `${encodedPayload}.${signature}`;
}

function verifyUserSessionToken(token) {
  const secret = getUserSessionSecret();

  if (!secret || !token) {
    return null;
  }

  const parts = String(token).split(".");

  if (parts.length !== 2) {
    return null;
  }

  const [encodedPayload, suppliedSignature] = parts;

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");

  const expectedBuffer = Buffer.from(expectedSignature);
  const suppliedBuffer = Buffer.from(suppliedSignature);

  if (
    expectedBuffer.length !== suppliedBuffer.length ||
    !crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8")
    );

    if (
      !payload ||
      !payload.sub ||
      !payload.exp ||
      Number(payload.exp) <= Date.now()
    ) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

async function requireUserSession(req, res, next) {
  try {
    const authorization = String(
      req.headers.authorization || ""
    );

    const token = authorization.startsWith("Bearer ")
      ? authorization.slice(7).trim()
      : "";

    const payload = verifyUserSessionToken(token);

    if (!payload || !mongoose.Types.ObjectId.isValid(payload.sub)) {
      return res.status(401).json({
        success: false,
        error: "User session invalid ya expire ho chuki hai."
      });
    }

    const user = await User.findById(payload.sub);

    if (!user) {
      return res.status(401).json({
        success: false,
        error: "User account nahi mila."
      });
    }

    req.authUser = user;
    next();
  } catch (err) {
    console.error("User session verification error:", err);

    return res.status(500).json({
      success: false,
      error: "User session verify nahi ho saki."
    });
  }
}


// ======================================================
// NOTIFICATION CENTER API
// ======================================================

app.get("/api/notifications", requireUserSession, async (req, res) => {
  try {
    const limit = Math.min(
      100,
      Math.max(1, Number.parseInt(req.query.limit, 10) || 60)
    );

    const [notifications, unreadCount] = await Promise.all([
      AppNotification.find({
        recipientUserId: req.authUser._id
      })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean(),

      AppNotification.countDocuments({
        recipientUserId: req.authUser._id,
        read: false
      })
    ]);

    return res.status(200).json({
      success: true,
      unreadCount,
      notifications: notifications.map(serializeNotification)
    });
  } catch (err) {
    console.error("Notification list error:", err);
    return res.status(500).json({
      success: false,
      error: "Notifications load nahi ho sake."
    });
  }
});

app.patch(
  "/api/notifications/:notificationId/read",
  requireUserSession,
  async (req, res) => {
    try {
      const notificationId = String(req.params.notificationId || "");

      if (!mongoose.Types.ObjectId.isValid(notificationId)) {
        return res.status(400).json({
          success: false,
          error: "Invalid notification ID."
        });
      }

      const notification = await AppNotification.findOneAndUpdate(
        {
          _id: notificationId,
          recipientUserId: req.authUser._id
        },
        {
          $set: { read: true }
        },
        {
          new: true
        }
      );

      if (!notification) {
        return res.status(404).json({
          success: false,
          error: "Notification nahi mila."
        });
      }

      return res.status(200).json({
        success: true,
        notification: serializeNotification(notification)
      });
    } catch (err) {
      console.error("Notification read error:", err);
      return res.status(500).json({
        success: false,
        error: "Notification read save nahi ho saka."
      });
    }
  }
);

app.post(
  "/api/notifications/mark-all-read",
  requireUserSession,
  async (req, res) => {
    try {
      await AppNotification.updateMany(
        {
          recipientUserId: req.authUser._id,
          read: false
        },
        {
          $set: { read: true }
        }
      );

      return res.status(200).json({ success: true });
    } catch (err) {
      console.error("Mark notifications read error:", err);
      return res.status(500).json({
        success: false,
        error: "Notifications update nahi ho sake."
      });
    }
  }
);

app.delete(
  "/api/notifications/:notificationId",
  requireUserSession,
  async (req, res) => {
    try {
      const notificationId = String(req.params.notificationId || "");

      if (!mongoose.Types.ObjectId.isValid(notificationId)) {
        return res.status(400).json({
          success: false,
          error: "Invalid notification ID."
        });
      }

      const deleted = await AppNotification.findOneAndDelete({
        _id: notificationId,
        recipientUserId: req.authUser._id
      });

      if (!deleted) {
        return res.status(404).json({
          success: false,
          error: "Notification nahi mila."
        });
      }

      return res.status(200).json({ success: true });
    } catch (err) {
      console.error("Notification delete error:", err);
      return res.status(500).json({
        success: false,
        error: "Notification delete nahi ho saka."
      });
    }
  }
);

app.post(
  "/api/notifications/:notificationId/action",
  requireUserSession,
  async (req, res) => {
    try {
      const notificationId = String(req.params.notificationId || "");
      const action = String(req.body.action || "").trim().toLowerCase();

      if (!mongoose.Types.ObjectId.isValid(notificationId)) {
        return res.status(400).json({
          success: false,
          error: "Invalid notification ID."
        });
      }

      const notification = await AppNotification.findOne({
        _id: notificationId,
        recipientUserId: req.authUser._id
      });

      if (!notification) {
        return res.status(404).json({
          success: false,
          error: "Notification nahi mila."
        });
      }

      if (notification.type === "friend_request") {
        if (!["accept", "reject"].includes(action)) {
          return res.status(400).json({
            success: false,
            error: "Friend request ke liye accept ya reject use karein."
          });
        }

        if (notification.actionStatus !== "pending") {
          return res.status(409).json({
            success: false,
            error: "Is friend request par pehle hi action ho chuka hai."
          });
        }

        const senderUserId =
          notification.senderUserId ||
          notification.data?.senderUserId;

        if (
          action === "accept" &&
          senderUserId &&
          mongoose.Types.ObjectId.isValid(String(senderUserId))
        ) {
          const pairKey = canonicalFriendPair(
            req.authUser._id,
            senderUserId
          );

          await Friendship.findOneAndUpdate(
            { pairKey },
            {
              $setOnInsert: {
                pairKey,
                users: [req.authUser._id, senderUserId],
                acceptedAt: new Date()
              }
            },
            {
              upsert: true,
              new: true
            }
          );
        }

        notification.actionStatus =
          action === "accept" ? "accepted" : "rejected";
        notification.read = true;
        await notification.save();

        if (
          senderUserId &&
          mongoose.Types.ObjectId.isValid(String(senderUserId))
        ) {
          await createAndPushNotification({
            recipientUserId: senderUserId,
            senderUserId: req.authUser._id,
            senderName: req.authUser.name,
            type: "friend_response",
            title:
              action === "accept"
                ? "Friend request accepted"
                : "Friend request declined",
            message:
              action === "accept"
                ? `${req.authUser.name} accepted your friend request.`
                : `${req.authUser.name} declined your friend request.`,
            data: {
              friendUserId: String(req.authUser._id),
              result: action
            },
            actionStatus:
              action === "accept" ? "accepted" : "rejected"
          });
        }

        return res.status(200).json({
          success: true,
          actionStatus: notification.actionStatus,
          notification: serializeNotification(notification)
        });
      }

      if (notification.type === "challenge") {
        if (action !== "open") {
          return res.status(400).json({
            success: false,
            error: "Challenge notification ko Open Game se kholen."
          });
        }

        notification.actionStatus = "opened";
        notification.read = true;
        await notification.save();

        return res.status(200).json({
          success: true,
          actionStatus: "opened",
          data: notification.data || {}
        });
      }

      notification.read = true;
      await notification.save();

      return res.status(200).json({
        success: true,
        notification: serializeNotification(notification)
      });
    } catch (err) {
      console.error("Notification action error:", err);
      return res.status(500).json({
        success: false,
        error: "Notification action complete nahi ho saka."
      });
    }
  }
);

app.get("/api/friends", requireUserSession, async (req, res) => {
  try {
    const friendships = await Friendship.find({
      users: req.authUser._id
    })
      .sort({ acceptedAt: -1 })
      .lean();

    const friendIds = friendships
      .flatMap((item) => item.users || [])
      .map(String)
      .filter((id) => id !== String(req.authUser._id));

    const friends = await User.find({
      _id: { $in: friendIds }
    })
      .select("_id name phone")
      .lean();

    return res.status(200).json({
      success: true,
      friends: friends.map((friend) => ({
        id: String(friend._id),
        name: friend.name,
        phone: friend.phone
      }))
    });
  } catch (err) {
    console.error("Friends list error:", err);
    return res.status(500).json({
      success: false,
      error: "Friends load nahi ho sake."
    });
  }
});

app.post(
  "/api/admin/notifications/broadcast",
  requireUserSession,
  async (req, res) => {
    try {
      if (!isAdminPhone(req.authUser.phone)) {
        return res.status(403).json({
          success: false,
          error: "Sirf admin notification send kar sakta hai."
        });
      }

      const target = String(req.body.target || "all").trim().toLowerCase();
      const phone = String(req.body.phone || "").trim();
      const title = String(req.body.title || "").trim().slice(0, 120);
      const message = String(req.body.message || "").trim().slice(0, 1200);
      const priority =
        String(req.body.priority || "important").toLowerCase() === "normal"
          ? "normal"
          : "important";

      if (!title || !message) {
        return res.status(400).json({
          success: false,
          error: "Title aur message required hain."
        });
      }

      let users = [];

      if (target === "specific") {
        if (!phone) {
          return res.status(400).json({
            success: false,
            error: "Specific user ke liye phone number required hai."
          });
        }

        const normalizedPhone = normalizeAdminPhone(phone);

        const user = await User.findOne({
          $or: [{ phone }, { phone: normalizedPhone }]
        })
          .select("_id")
          .lean();

        if (!user) {
          return res.status(404).json({
            success: false,
            error: "Is phone number ka user nahi mila."
          });
        }

        users = [user];
      } else {
        users = await User.find({}).select("_id").lean();
      }

      if (users.length === 0) {
        return res.status(200).json({
          success: true,
          sentCount: 0
        });
      }

      const sourceKey = `admin_${Date.now()}`;
      const docs = users.map((targetUser) => ({
        recipientUserId: targetUser._id,
        senderUserId: req.authUser._id,
        senderName: "SAMATKAAR",
        type: "admin_message",
        title,
        message,
        data: { priority },
        read: false,
        actionStatus: "none",
        sourceKey
      }));

      const inserted = await AppNotification.insertMany(docs);

      for (const notification of inserted) {
        io.to(
          notificationRoom(notification.recipientUserId)
        ).emit(
          "notification:new",
          serializeNotification(notification)
        );
      }

      return res.status(201).json({
        success: true,
        sentCount: inserted.length
      });
    } catch (err) {
      console.error("Admin broadcast error:", err);
      return res.status(500).json({
        success: false,
        error: "Admin notification send nahi ho saka."
      });
    }
  }
);


function createAdminToken(user) {
  const secret = getAdminSigningSecret();

  if (!secret) {
    throw new Error(
      "ADMIN_DEPOSIT_KEY server par configure nahi hai."
    );
  }

  const payload = {
    sub: String(user._id),
    phone: normalizeAdminPhone(user.phone),
    role: "admin",
    exp: Date.now() + ADMIN_TOKEN_TTL_MS
  };

  const encodedPayload = Buffer.from(
    JSON.stringify(payload)
  ).toString("base64url");

  const signature = crypto
    .createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");

  return `${encodedPayload}.${signature}`;
}

function verifyAdminToken(token) {
  const secret = getAdminSigningSecret();

  if (!secret || !token) {
    return null;
  }

  const parts = String(token).split(".");

  if (parts.length !== 2) {
    return null;
  }

  const [encodedPayload, suppliedSignature] = parts;

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");

  const expectedBuffer = Buffer.from(expectedSignature);
  const suppliedBuffer = Buffer.from(suppliedSignature);

  if (
    expectedBuffer.length !== suppliedBuffer.length ||
    !crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8")
    );

    if (
      !payload ||
      payload.role !== "admin" ||
      !payload.sub ||
      !payload.exp ||
      Number(payload.exp) <= Date.now() ||
      !isAdminPhone(payload.phone)
    ) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

function getAdminAttemptKey(req) {
  return String(
    req.headers["x-forwarded-for"] ||
      req.ip ||
      req.socket?.remoteAddress ||
      "unknown"
  )
    .split(",")[0]
    .trim();
}

function adminLoginBlocked(key) {
  const entry = adminLoginAttempts.get(key);

  if (!entry) {
    return false;
  }

  if (Date.now() - entry.firstFailureAt > ADMIN_LOGIN_WINDOW_MS) {
    adminLoginAttempts.delete(key);
    return false;
  }

  return entry.failures >= ADMIN_LOGIN_MAX_FAILURES;
}

function recordAdminLoginFailure(key) {
  const now = Date.now();
  const existing = adminLoginAttempts.get(key);

  if (
    !existing ||
    now - existing.firstFailureAt > ADMIN_LOGIN_WINDOW_MS
  ) {
    adminLoginAttempts.set(key, {
      failures: 1,
      firstFailureAt: now
    });
    return;
  }

  existing.failures += 1;
  adminLoginAttempts.set(key, existing);
}

async function requireDepositAdmin(req, res, next) {
  try {
    const authorization = String(
      req.headers.authorization || ""
    );

    const token = authorization.startsWith("Bearer ")
      ? authorization.slice(7).trim()
      : "";

    const payload = verifyAdminToken(token);

    if (!payload) {
      return res.status(401).json({
        success: false,
        error: "Admin session invalid ya expire ho chuki hai."
      });
    }

    if (!mongoose.Types.ObjectId.isValid(payload.sub)) {
      return res.status(401).json({
        success: false,
        error: "Invalid admin session."
      });
    }

    const adminUser = await User.findById(payload.sub)
      .select("_id name phone coins")
      .lean();

    if (!adminUser || !isAdminPhone(adminUser.phone)) {
      return res.status(403).json({
        success: false,
        error: "Is account ko admin access nahi hai."
      });
    }

    req.adminUser = adminUser;
    next();
  } catch (err) {
    console.error("Admin authorization error:", err);

    return res.status(500).json({
      success: false,
      error: "Admin authorization check fail ho gaya."
    });
  }
}

// ======================================================
// ADMIN LOGIN - SHORT-LIVED SIGNED TOKEN
// ======================================================

app.post("/api/admin/auth/login", async (req, res) => {
  try {
    if (!process.env.ADMIN_PHONE) {
      return res.status(503).json({
        success: false,
        error: "ADMIN_PHONE server par configure nahi hai."
      });
    }

    if (!process.env.ADMIN_DEPOSIT_KEY) {
      return res.status(503).json({
        success: false,
        error: "ADMIN_DEPOSIT_KEY server par configure nahi hai."
      });
    }

    const attemptKey = getAdminAttemptKey(req);

    if (adminLoginBlocked(attemptKey)) {
      return res.status(429).json({
        success: false,
        error:
          "Bohat zyada failed admin login attempts. 15 minutes baad dobara try karein."
      });
    }

    const phone = String(req.body.phone || "").trim();
    const password = String(req.body.password || "");

    if (!phone || !password) {
      return res.status(400).json({
        success: false,
        error: "Admin phone aur password required hain."
      });
    }

    if (!isAdminPhone(phone)) {
      recordAdminLoginFailure(attemptKey);

      return res.status(403).json({
        success: false,
        error: "Is phone number ko admin access nahi hai."
      });
    }

    const normalizedInputPhone = normalizeAdminPhone(phone);

    const user = await User.findOne({
      $or: [
        { phone },
        { phone: normalizedInputPhone }
      ]
    });

    if (!user || !isAdminPhone(user.phone)) {
      recordAdminLoginFailure(attemptKey);

      return res.status(403).json({
        success: false,
        error: "Admin account database mein nahi mila."
      });
    }

    if (user.password !== password) {
      recordAdminLoginFailure(attemptKey);

      return res.status(401).json({
        success: false,
        error: "Admin password ghalat hai."
      });
    }

    adminLoginAttempts.delete(attemptKey);

    const token = createAdminToken(user);

    return res.status(200).json({
      success: true,
      message: "Admin login successful.",
      token,
      expiresInMs: ADMIN_TOKEN_TTL_MS,
      admin: {
        id: user._id,
        name: user.name,
        phone: user.phone,
        role: "admin"
      }
    });
  } catch (err) {
    console.error("Admin login error:", err);

    return res.status(500).json({
      success: false,
      error: "Admin login nahi ho saka."
    });
  }
});

// ======================================================
// STEP 2 - CREATE PENDING DEPOSIT
// ======================================================

app.post("/api/deposits/create", async (req, res) => {
  try {
    const {
      userId,
      amountPKR,
      method,
      transactionId
    } = req.body;

    if (!userId || amountPKR === undefined || !method || !transactionId) {
      return res.status(400).json({
        success: false,
        error: "userId, amountPKR, method aur transactionId required hain."
      });
    }

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid User ID."
      });
    }

    const amount = Number(amountPKR);

    if (
      !Number.isFinite(amount) ||
      amount < MIN_DEPOSIT_PKR ||
      amount > MAX_DEPOSIT_PKR
    ) {
      return res.status(400).json({
        success: false,
        error: `Deposit Rs.${MIN_DEPOSIT_PKR} se Rs.${MAX_DEPOSIT_PKR} ke darmiyan hona chahiye.`
      });
    }

    // Paisa whole PKR mein rakho.
    if (!Number.isInteger(amount)) {
      return res.status(400).json({
        success: false,
        error: "Deposit amount whole PKR mein hona chahiye."
      });
    }

    const normalizedMethod = String(method).trim().toLowerCase();

    if (!["easypaisa", "jazzcash"].includes(normalizedMethod)) {
      return res.status(400).json({
        success: false,
        error: "Sirf Easypaisa ya JazzCash deposit supported hai."
      });
    }

    const normalizedTrxId = normalizeTransactionId(transactionId);

    if (normalizedTrxId.length < 4 || normalizedTrxId.length > 100) {
      return res.status(400).json({
        success: false,
        error: "Transaction ID invalid hai."
      });
    }

    const user = await User.findById(userId).select("_id name phone coins");

    if (!user) {
      return res.status(404).json({
        success: false,
        error: "User database mein nahi mila."
      });
    }

    const duplicate = await Deposit.findOne({
      transactionId: normalizedTrxId
    }).lean();

    if (duplicate) {
      return res.status(409).json({
        success: false,
        error: "Yeh Transaction ID pehle submit ho chuki hai.",
        depositId: duplicate._id,
        status: duplicate.status
      });
    }

    const coinsToCredit = calculateDepositCoins(amount);

    const deposit = await Deposit.create({
      userId: user._id,
      amountPKR: amount,
      coinsToCredit,
      method: normalizedMethod,
      transactionId: normalizedTrxId,
      status: "pending"
    });

    return res.status(201).json({
      success: true,
      message: "Deposit submit ho gaya. Verification pending hai.",
      deposit: {
        id: deposit._id,
        amountPKR: deposit.amountPKR,
        coinsToCredit: deposit.coinsToCredit,
        method: deposit.method,
        transactionId: deposit.transactionId,
        status: deposit.status,
        submittedAt: deposit.submittedAt
      }
    });
  } catch (err) {
    // Unique index is the final duplicate-TRX protection.
    if (err && err.code === 11000) {
      return res.status(409).json({
        success: false,
        error: "Yeh Transaction ID pehle use ho chuki hai."
      });
    }

    console.error("Deposit create error:", err);

    return res.status(500).json({
      success: false,
      error: "Deposit request create nahi ho saki."
    });
  }
});

// ======================================================
// STEP 3 - USER DEPOSIT HISTORY / STATUS
// ======================================================

app.get("/api/deposits/user/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid User ID."
      });
    }

    const deposits = await Deposit.find({ userId })
      .sort({ createdAt: -1 })
      .select(
        "_id amountPKR coinsToCredit method transactionId status submittedAt approvedAt rejectedAt creditedAt rejectionReason createdAt"
      )
      .lean();

    return res.status(200).json({
      success: true,
      deposits
    });
  } catch (err) {
    console.error("Deposit history error:", err);

    return res.status(500).json({
      success: false,
      error: "Deposit history load nahi ho saki."
    });
  }
});

// ======================================================
// STEP 4 + STEP 5 - APPROVE AND CREDIT COINS EXACTLY ONCE
// ======================================================

app.post(
  "/api/admin/deposits/:depositId/approve",
  requireDepositAdmin,
  async (req, res) => {
    const session = await mongoose.startSession();

    try {
      let responseData = null;

      await session.withTransaction(async () => {
        const deposit = await Deposit.findById(req.params.depositId).session(
          session
        );

        if (!deposit) {
          const error = new Error("Deposit database mein nahi mila.");
          error.httpStatus = 404;
          throw error;
        }

        if (deposit.status === "approved" || deposit.creditedAt) {
          const error = new Error(
            "Yeh deposit pehle hi approve/credit ho chuka hai."
          );
          error.httpStatus = 409;
          throw error;
        }

        if (deposit.status === "rejected") {
          const error = new Error(
            "Rejected deposit ko direct approve nahi kiya ja sakta."
          );
          error.httpStatus = 409;
          throw error;
        }

        const user = await User.findByIdAndUpdate(
          deposit.userId,
          {
            $inc: {
              coins: deposit.coinsToCredit
            }
          },
          {
            new: true,
            session
          }
        );

        if (!user) {
          const error = new Error("Deposit ka user database mein nahi mila.");
          error.httpStatus = 404;
          throw error;
        }

        const now = new Date();

        deposit.status = "approved";
        deposit.approvedAt = now;
        deposit.creditedAt = now;
        deposit.rejectedAt = null;
        deposit.rejectionReason = "";

        await deposit.save({ session });

        responseData = {
          depositId: deposit._id,
          status: deposit.status,
          amountPKR: deposit.amountPKR,
          coinsCredited: deposit.coinsToCredit,
          creditedAt: deposit.creditedAt,
          user: {
            id: user._id,
            name: user.name,
            coins: user.coins
          }
        };
      });

      if (responseData?.user?.id) {
        await createAndPushNotification({
          recipientUserId: responseData.user.id,
          senderName: "SAMATKAAR",
          type: "deposit_approved",
          title: "Deposit approved",
          message: `${responseData.coinsCredited} coins have been added to your wallet.`,
          data: {
            depositId: String(responseData.depositId || ""),
            amountPKR: responseData.amountPKR,
            coinsCredited: responseData.coinsCredited
          },
          sourceKey: `deposit_${responseData.depositId}_approved`
        });
      }

      return res.status(200).json({
        success: true,
        message: "Deposit approved. Coins successfully credit ho gaye.",
        ...responseData
      });
    } catch (err) {
      console.error("Deposit approve error:", err);

      return res.status(err.httpStatus || 500).json({
        success: false,
        error: err.message || "Deposit approve nahi ho saka."
      });
    } finally {
      await session.endSession();
    }
  }
);

// ======================================================
// STEP 6 - REJECT FAKE / INVALID DEPOSIT
// ======================================================

app.post(
  "/api/admin/deposits/:depositId/reject",
  requireDepositAdmin,
  async (req, res) => {
    try {
      const reason = String(req.body.reason || "Payment verify nahi hui.")
        .trim()
        .slice(0, 300);

      const deposit = await Deposit.findOneAndUpdate(
        {
          _id: req.params.depositId,
          status: "pending",
          creditedAt: null
        },
        {
          $set: {
            status: "rejected",
            rejectedAt: new Date(),
            rejectionReason: reason
          }
        },
        {
          new: true
        }
      );

      if (!deposit) {
        const existing = await Deposit.findById(req.params.depositId).lean();

        if (!existing) {
          return res.status(404).json({
            success: false,
            error: "Deposit database mein nahi mila."
          });
        }

        return res.status(409).json({
          success: false,
          error:
            existing.status === "approved"
              ? "Approved deposit reject nahi ho sakta."
              : "Deposit pending state mein nahi hai.",
          status: existing.status
        });
      }

      await createAndPushNotification({
        recipientUserId: deposit.userId,
        senderName: "SAMATKAAR",
        type: "deposit_rejected",
        title: "Deposit not approved",
        message:
          deposit.rejectionReason ||
          "Your payment could not be verified.",
        data: {
          depositId: String(deposit._id),
          reason: deposit.rejectionReason
        },
        sourceKey: `deposit_${deposit._id}_rejected`
      });

      return res.status(200).json({
        success: true,
        message: "Deposit reject kar diya gaya. Koi coins add nahi hue.",
        deposit: {
          id: deposit._id,
          status: deposit.status,
          rejectionReason: deposit.rejectionReason,
          rejectedAt: deposit.rejectedAt
        }
      });
    } catch (err) {
      console.error("Deposit reject error:", err);

      return res.status(500).json({
        success: false,
        error: "Deposit reject nahi ho saka."
      });
    }
  }
);

// ======================================================
// ADMIN - PENDING DEPOSITS
// ======================================================

app.get(
  "/api/admin/deposits/pending",
  requireDepositAdmin,
  async (req, res) => {
    try {
      const deposits = await Deposit.find({ status: "pending" })
        .sort({ createdAt: 1 })
        .populate("userId", "name phone coins")
        .lean();

      return res.status(200).json({
        success: true,
        deposits
      });
    } catch (err) {
      console.error("Pending deposits error:", err);

      return res.status(500).json({
        success: false,
        error: "Pending deposits load nahi ho sake."
      });
    }
  }
);









// ======================================================



// LUCKY DRAW - SECURE TICKET MODEL & GENERATOR



// ======================================================







const luckyTicketSchema = new mongoose.Schema(



  {



    publicCode: {



      type: String,



      required: true,



      unique: true,



      index: true



    },







    secretCode: {



      type: String,



      required: true,



      unique: true



    },







    userId: {



      type: String,



      required: true,



      index: true



    },







    userName: {



      type: String,



      required: true



    },







    phone: {



      type: String,



      required: true



    },







    roundId: {



      type: String,



      required: true,



      index: true



    },







    paymentMethod: {



      type: String,



      enum: ["coins"],



      required: true



    },







    status: {



      type: String,



      enum: [



        "active",



        "expired",



        "winner",



        "cancelled"



      ],



      default: "active",



      index: true



    },







    issuedAt: {



      type: Date,



      default: Date.now



    },







    expiresAt: {



      type: Date,



      required: true



    }



  },



  {



    timestamps: true



  }



);







const LuckyTicket =



  mongoose.models.LuckyTicket ||



  mongoose.model(



    "LuckyTicket",



    luckyTicketSchema



  );







    // ======================================================



// LUCKY DRAW - ROUND MODEL



// ======================================================







const luckyRoundSchema = new mongoose.Schema(



  {



    roundId: {



      type: String,



      required: true,



      unique: true,



      index: true



    },







    status: {



      type: String,



      enum: ["active", "drawing", "completed"],



      default: "active",



      index: true



    },







    startsAt: {



      type: Date,



      required: true



    },







    endsAt: {



      type: Date,



      required: true



    },







    winnerTicketId: {



      type: mongoose.Schema.Types.ObjectId,



      ref: "LuckyTicket",



      default: null



    },







    winnerPublicCode: {



      type: String,



      default: null



    },







    winnerUserId: {



      type: String,



      default: null



    },







    completedAt: {



      type: Date,



      default: null



    }



  },



  {



    timestamps: true



  }



);







const LuckyRound =



  mongoose.models.LuckyRound ||



  mongoose.model(



    "LuckyRound",



    luckyRoundSchema



  );







  // ======================================================



// LUCKY DRAW - ROUND SETTINGS



// ======================================================







// Har Lucky Draw round 8 din chalega.



const LUCKY_DRAW_ROUND_DAYS = 8;











// ======================================================



// CREATE NEW ROUND



// ======================================================







async function createNewLuckyRound() {



  const startsAt = new Date();







  const endsAt = new Date(



    startsAt.getTime() +



    LUCKY_DRAW_ROUND_DAYS *



    24 *



    60 *



    60 *



    1000



  );







  const roundId =



    `ROUND-${Date.now()}`;







  const round = await LuckyRound.create({



    roundId,



    status: "active",



    startsAt,



    endsAt



  });







  console.log(



    `🎟️ New Lucky Draw round created: ${round.roundId}`



  );







  return round;



}



// ======================================================

// LUCKY DRAW - CLOSE ROUND & SELECT WINNER

// ======================================================



async function closeLuckyRound(round) {

  if (!round) {

    throw new Error("Lucky Draw round missing hai.");

  }



  // Agar pehle hi complete hai to dobara draw mat karo.

  if (round.status === "completed") {

    return round;

  }



  const now = new Date();



  // ------------------------------------------

  // ROUND LOCK KARO

  // ------------------------------------------



 const lockedRound = await LuckyRound.findOneAndUpdate(

  {

    _id: round._id,

    status: {

      $in: ["active", "drawing"]

    }

  },

  {

    $set: {

      status: "drawing"

    }

  },

  {

    new: true

  }

);



  // Agar kisi doosri request ne already lock kar diya

  // to latest round return karo.

  if (!lockedRound) {

    return await LuckyRound.findById(round._id);

  }



  // ------------------------------------------

  // CURRENT ROUND KE ACTIVE TICKETS

  // ------------------------------------------



  const activeTickets = await LuckyTicket.find({

    roundId: lockedRound.roundId,

    status: "active",

    expiresAt: {

      $lte: now

    }

  });



  // ------------------------------------------

  // AGAR KOI TICKET NAHI

  // ------------------------------------------



  if (activeTickets.length === 0) {

    lockedRound.status = "completed";

    lockedRound.completedAt = now;



    await lockedRound.save();



    console.log(

      `🎟️ ${lockedRound.roundId} completed - no tickets sold.`

    );



    return lockedRound;

  }



  // ------------------------------------------

  // CRYPTOGRAPHICALLY RANDOM WINNER

  // ------------------------------------------



  const winnerIndex = crypto.randomInt(

    0,

    activeTickets.length

  );



  const winnerTicket =

    activeTickets[winnerIndex];



  // ------------------------------------------

  // WINNER TICKET

  // ------------------------------------------



  winnerTicket.status = "winner";



  await winnerTicket.save();



  // ------------------------------------------

  // BAAQI TICKETS EXPIRE

  // ------------------------------------------



  await LuckyTicket.updateMany(

    {

      roundId: lockedRound.roundId,



      _id: {

        $ne: winnerTicket._id

      },



      status: "active"

    },

    {

      $set: {

        status: "expired"

      }

    }

  );



  // ------------------------------------------

  // WINNER ROUND ME PERMANENTLY SAVE

  // ------------------------------------------



  lockedRound.status = "completed";



  lockedRound.winnerTicketId =

    winnerTicket._id;



  lockedRound.winnerPublicCode =

    winnerTicket.publicCode;



  lockedRound.winnerUserId =

    winnerTicket.userId;



  lockedRound.completedAt = now;



  await lockedRound.save();



  console.log(

    `🏆 Lucky Draw Winner: ${winnerTicket.publicCode} | Round: ${lockedRound.roundId}`

  );



  return lockedRound;

}







// ======================================================



// GET CURRENT ACTIVE ROUND



// ======================================================







// ======================================================

// GET CURRENT ACTIVE ROUND

// ======================================================



async function getCurrentLuckyRound() {

  const now = new Date();



  // ------------------------------------------

  // PEHLE EXPIRED ACTIVE ROUND CHECK KARO

  // ------------------------------------------



  const expiredRound =

    await LuckyRound.findOne({

      status: "active",



      endsAt: {

        $lte: now

      }

    }).sort({

      startsAt: 1

    });



  // Round time khatam ho gaya:

  // pehle winner select hoga.

  if (expiredRound) {

    await closeLuckyRound(expiredRound);

  }



  // ------------------------------------------

  // AGAR DRAWING ROUND HAI

  // ------------------------------------------



  const drawingRound =

    await LuckyRound.findOne({

      status: "drawing"

    });



  if (drawingRound) {

    await closeLuckyRound(drawingRound);

  }



  // ------------------------------------------

  // CURRENT VALID ACTIVE ROUND

  // ------------------------------------------



  let currentRound =

    await LuckyRound.findOne({

      status: "active",



      endsAt: {

        $gt: now

      }

    }).sort({

      startsAt: -1

    });



  if (currentRound) {

    return currentRound;

  }



  // ------------------------------------------

  // KOI ACTIVE ROUND NAHI = NEW ROUND

  // ------------------------------------------



  currentRound =

    await createNewLuckyRound();



  return currentRound;

}



// ======================================================



// SECURE RANDOM TICKET GENERATOR



// ======================================================







function randomTicketPart(length) {



  // I and O intentionally remove kiye hain



  // taake 1/I aur 0/O ka confusion na ho.



  const chars =



    "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";







  let result = "";







  for (let i = 0; i < length; i += 1) {



    const randomIndex =



      crypto.randomInt(0, chars.length);







    result += chars[randomIndex];



  }







  return result;



}







// ======================================================



// GENERATE UNIQUE LUCKY DRAW TICKET



// ======================================================







async function generateSecureTicket() {



  while (true) {



    // USER KO YE DIKHEGA:



    // SK-8F4K4KO2







    const publicCode =



      `SK-${randomTicketPart(8)}`;







    // USER KO YE PART NAHI DIYA JAYEGA:



    // 92QX







    const secretPart =



      randomTicketPart(4);







    // DATABASE MEIN COMPLETE CODE:



    // SK-8F4K4KO2-92QX







    const secretCode =



      `${publicCode}-${secretPart}`;







    // Check karo ke same ticket pehle se



    // database mein exist na karta ho.







    const exists =



      await LuckyTicket.exists({



        $or: [



          {



            publicCode: publicCode



          },



          {



            secretCode: secretCode



          }



        ]



      });







    // Unique hai to return karo.



    if (!exists) {



      return {



        publicCode,



        secretCode



      };



    }







    // Agar collision hua to while loop



    // automatically naya code banayega.



  }



}







// ======================================================



// LUCKY DRAW - CREATE TICKET API



// ======================================================







app.post("/api/lucky-draw/tickets/create", async (req, res) => {



  try {



    const {

      userId,

      paymentMethod

    } = req.body;







    // ------------------------------------------



    // REQUIRED DATA CHECK



    // ------------------------------------------







    if (!userId || !paymentMethod) {



      return res.status(400).json({



        success: false,



        error: "Required ticket information missing hai."



      });



    }







    // ------------------------------------------



    // USER ID CHECK



    // ------------------------------------------







    if (!mongoose.Types.ObjectId.isValid(userId)) {



      return res.status(400).json({



        success: false,



        error: "Invalid User ID."



      });



    }







    // ------------------------------------------



    // PAYMENT METHOD CHECK



    // ------------------------------------------







    const allowedPaymentMethods = ["coins"];







    if (!allowedPaymentMethods.includes(paymentMethod)) {



      return res.status(400).json({



        success: false,



        error: "Invalid payment method."



      });



    }



    // ------------------------------------------

    // SERVER-CONTROLLED CURRENT ROUND

    // ------------------------------------------



    const currentRound = await getCurrentLuckyRound();

    const roundId = currentRound.roundId;

    const ticketExpiry = currentRound.endsAt;









    // ------------------------------------------



    // DATABASE SE REAL USER FIND KARO



    // ------------------------------------------







    const user = await User.findById(userId);







    if (!user) {



      return res.status(404).json({



        success: false,



        error: "User database mein nahi mila."



      });



    }







    // ------------------------------------------



    // COINS PAYMENT



    // ------------------------------------------







    const TICKET_PRICE_COINS = 2000;







    if (paymentMethod === "coins") {



      if (user.coins < TICKET_PRICE_COINS) {



        return res.status(400).json({



          success: false,



          error: "Insufficient coins.",



          requiredCoins: TICKET_PRICE_COINS,



          availableCoins: user.coins



        });



      }







      user.coins -= TICKET_PRICE_COINS;







      await user.save();



    }







    // ------------------------------------------



    // GENERATE SECURE UNIQUE TICKET



    // ------------------------------------------







    const {



      publicCode,



      secretCode



    } = await generateSecureTicket();







    // ------------------------------------------



    // DATABASE ME TICKET SAVE



    // ------------------------------------------







    const ticket = new LuckyTicket({



      publicCode,







      // IMPORTANT:



      // Ye complete secret ticket sirf DB mein rahega.



      secretCode,







      userId: String(user._id),







      userName: user.name,







      phone: user.phone,







      roundId: String(roundId),







      paymentMethod,







      status: "active",







      issuedAt: new Date(),







      expiresAt: ticketExpiry



    });







    await ticket.save();







    // ------------------------------------------



    // USER KO SECRET CODE MAT BHEJNA



    // ------------------------------------------







    return res.status(201).json({



      success: true,







      message: "Lucky Draw ticket successfully issued.",







      ticket: {



        id: ticket._id,







        // User ko sirf ye code milega:



        // SK-XXXXXXXX



        code: ticket.publicCode,







        roundId: ticket.roundId,







        status: ticket.status,







        issuedAt: ticket.issuedAt,







        expiresAt: ticket.expiresAt



      },







      coins: user.coins



    });







  } catch (err) {



    console.error(



      "Lucky Draw ticket create error:",



      err



    );







    return res.status(500).json({



      success: false,



      error: "Ticket create nahi ho saka."



    });



  }



});







// ======================================================



// LUCKY DRAW - VERIFY TICKET API



// ======================================================







app.post("/api/lucky-draw/tickets/verify", async (req, res) => {



  try {



    const {

      code,

      userId

    } = req.body;







    // ------------------------------------------



    // REQUIRED DATA



    // ------------------------------------------







    if (!code || !userId) {



      return res.status(400).json({



        success: false,



        valid: false,



        error: "Ticket code aur User ID required hain."



      });



    }







    // ------------------------------------------



    // USER ID VALIDATION



    // ------------------------------------------







    if (!mongoose.Types.ObjectId.isValid(userId)) {



      return res.status(400).json({



        success: false,



        valid: false,



        error: "Invalid User ID."



      });



    }







    // ------------------------------------------



    // NORMALIZE PUBLIC CODE



    // ------------------------------------------







    const publicCode = String(code)



      .trim()



      .toUpperCase();







    // Expected:



    // SK-8F4K4KO2







    if (!/^SK-[A-Z0-9]{8}$/.test(publicCode)) {



      return res.status(400).json({



        success: false,



        valid: false,



        status: "invalid",



        error: "Ticket format invalid hai."



      });



    }







    // ------------------------------------------



    // FIND TICKET



    // IMPORTANT:



    // secretCode se verification nahi hogi.



    // ------------------------------------------







    const ticket = await LuckyTicket.findOne({



      publicCode



    });







    if (!ticket) {



      return res.status(404).json({



        success: false,



        valid: false,



        status: "invalid",



        error: "Ticket database mein nahi mila."



      });



    }







    // ------------------------------------------



    // CHECK TICKET OWNER



    // ------------------------------------------







    if (



      String(ticket.userId) !== String(userId)



    ) {



      return res.status(403).json({



        success: false,



        valid: false,



        status: "invalid",



        error: "Yeh ticket is account ka nahi hai."



      });



    }







    // ------------------------------------------

    // CHECK SERVER-CONTROLLED CURRENT ROUND

    // ------------------------------------------



    const currentRound = await getCurrentLuckyRound();



    if (String(ticket.roundId) !== String(currentRound.roundId)) {

      return res.status(400).json({

        success: false,

        valid: false,

        status: "wrong_round",

        error: "Yeh ticket current Lucky Draw round ka nahi hai."

      });

    }



    // ------------------------------------------



    // EXPIRY CHECK



    // ------------------------------------------







    const now = new Date();







    if (



      ticket.expiresAt &&



      new Date(ticket.expiresAt) <= now



    ) {



      // Database mein bhi expired kar do.







      if (ticket.status === "active") {



        ticket.status = "expired";







        await ticket.save();



      }







      return res.status(400).json({



        success: false,



        valid: false,



        status: "expired",



        error: "Yeh ticket expire ho chuka hai."



      });



    }







    // ------------------------------------------



    // STATUS CHECK



    // ------------------------------------------







    if (ticket.status === "expired") {



      return res.status(400).json({



        success: false,



        valid: false,



        status: "expired",



        error: "Yeh ticket expire ho chuka hai."



      });



    }







    if (ticket.status === "cancelled") {



      return res.status(400).json({



        success: false,



        valid: false,



        status: "cancelled",



        error: "Yeh ticket cancel ho chuka hai."



      });



    }







    // Winner ticket valid historical result ho sakta hai,



    // lekin active draw entry nahi hai.







    if (ticket.status === "winner") {



      return res.status(200).json({



        success: true,



        valid: false,



        status: "winner",



        message: "Yeh ticket previous winning ticket hai.",







        ticket: {



          code: ticket.publicCode,



          roundId: ticket.roundId,



          issuedAt: ticket.issuedAt,



          expiresAt: ticket.expiresAt



        }



      });



    }







    // ------------------------------------------



    // ACTIVE TICKET



    // ------------------------------------------







    if (ticket.status !== "active") {



      return res.status(400).json({



        success: false,



        valid: false,



        status: "invalid",



        error: "Ticket active nahi hai."



      });



    }







    // ------------------------------------------



    // SUCCESS



    // ------------------------------------------







    return res.status(200).json({



      success: true,



      valid: true,



      status: "active",







      message:



        "Ticket verified successfully. Lucky Draw entry active hai.",







      ticket: {



        code: ticket.publicCode,







        userName: ticket.userName,







        roundId: ticket.roundId,







        paymentMethod:



          ticket.paymentMethod,







        issuedAt:



          ticket.issuedAt,







        expiresAt:



          ticket.expiresAt



      }



    });







  } catch (err) {



    console.error(



      "Lucky Draw ticket verification error:",



      err



    );







    return res.status(500).json({



      success: false,



      valid: false,



      error: "Ticket verify nahi ho saka."



    });



  }



});







      // ======================================================



// LUCKY DRAW - CURRENT ROUND API



// ======================================================







app.get(



  "/api/lucky-draw/current-round",



  async (req, res) => {



    try {



      const round =



        await getCurrentLuckyRound();







      return res.status(200).json({



        success: true,







        round: {



          roundId: round.roundId,



          status: round.status,



          startsAt: round.startsAt,



          endsAt: round.endsAt



        }



      });







    } catch (err) {



      console.error(



        "Current Lucky Draw round error:",



        err



      );







      return res.status(500).json({



        success: false,



        error:



          "Current Lucky Draw round load nahi ho saka."



      });



    }



  }



);

// ======================================================

// LUCKY DRAW - LATEST WINNER API

// ======================================================



app.get(

  "/api/lucky-draw/latest-winner",

  async (req, res) => {

    try {

      const round =

        await LuckyRound.findOne({

          status: "completed",



          winnerTicketId: {

            $ne: null

          }

        })

          .sort({

            completedAt: -1

          })

          .lean();



      if (!round) {

        return res.status(404).json({

          success: false,

          message:

            "Abhi koi Lucky Draw winner available nahi hai."

        });

      }



      const winnerTicket =

        await LuckyTicket.findById(

          round.winnerTicketId

        ).lean();



      if (!winnerTicket) {

        return res.status(404).json({

          success: false,

          message:

            "Winner ticket database mein nahi mila."

        });

      }



      return res.status(200).json({

        success: true,



        winner: {

          roundId:

            round.roundId,



          ticketCode:

            winnerTicket.publicCode,



          userName:

            winnerTicket.userName,



          completedAt:

            round.completedAt

        }

      });



    } catch (err) {

      console.error(

        "Latest Lucky Draw winner error:",

        err

      );



      return res.status(500).json({

        success: false,

        error:

          "Lucky Draw winner load nahi ho saka."

      });

    }

  }

);

// ==========================



// API Routes - Signup



// ==========================







app.post("/api/auth/signup", async (req, res) => {



  try {



    const { name, phone, password } = req.body;







    const existingUser = await User.findOne({ phone });







    if (existingUser) {



      return res.status(400).json({



        error: "Yeh phone number pehle se registered hai!"



      });



    }







    const newUser = new User({



      name,



      phone,



      password,



      coins: 50



    });







    await newUser.save();







    res.status(201).json({



      success: true,



      message: "Account successfully create ho gaya!",







      token: createUserSessionToken(newUser),

      user: {



        id: newUser._id,



        name: newUser.name,



        phone: newUser.phone,



        coins: newUser.coins,
        role: isAdminPhone(newUser.phone) ? "admin" : "user"



      }



    });



  } catch (err) {



    res.status(500).json({



      error: "Server error: " + err.message



    });



  }



});







// ==========================



// API Routes - Login



// ==========================







app.post("/api/auth/login", async (req, res) => {



  try {



    const { phone, password } = req.body;







    const user = await User.findOne({ phone });







    if (!user) {



      return res.status(404).json({



        error: "Yeh phone number register nahi hai!"



      });



    }







    if (user.password !== password) {



      return res.status(400).json({



        error: "Ghalat Password!"



      });



    }







    res.status(200).json({



      success: true,



      message: "Login successful!",







      token: createUserSessionToken(user),

      user: {



        id: user._id,



        name: user.name,



        phone: user.phone,



        coins: user.coins,
        role: isAdminPhone(user.phone) ? "admin" : "user"



      }



    });



  } catch (err) {



    res.status(500).json({



      error: "Server error: " + err.message



    });



  }



});








// ======================================================
// USER BALANCE PERSISTENCE
// ======================================================
// These endpoints fix the old logout/login reset bug.
// The authenticated user is resolved from a signed server token;
// phone number from the request body is NOT trusted.
// ======================================================

app.get("/api/user/me", requireUserSession, async (req, res) => {
  try {
    const user = req.authUser;

    return res.status(200).json({
      success: true,
      user: {
        id: user._id,
        name: user.name,
        phone: user.phone,
        coins: Number(user.coins || 0),
        role: isAdminPhone(user.phone) ? "admin" : "user"
      }
    });
  } catch (err) {
    console.error("Get current user error:", err);

    return res.status(500).json({
      success: false,
      error: "Account balance load nahi ho saka."
    });
  }
});

app.post("/api/user/update-coins", requireUserSession, async (req, res) => {
  try {
    const requestedCoins = Number(req.body.coins);

    if (
      !Number.isFinite(requestedCoins) ||
      !Number.isInteger(requestedCoins) ||
      requestedCoins < 0 ||
      requestedCoins > 1000000000
    ) {
      return res.status(400).json({
        success: false,
        error: "Invalid coins balance."
      });
    }

    const updatedUser = await User.findByIdAndUpdate(
      req.authUser._id,
      {
        $set: {
          coins: requestedCoins
        }
      },
      {
        new: true,
        runValidators: true
      }
    );

    if (!updatedUser) {
      return res.status(404).json({
        success: false,
        error: "User account nahi mila."
      });
    }

    return res.status(200).json({
      success: true,
      coins: Number(updatedUser.coins || 0)
    });
  } catch (err) {
    console.error("Update coins error:", err);

    return res.status(500).json({
      success: false,
      error: "Coins save nahi ho sake."
    });
  }
});


// ==========================



// Root Route



// ==========================







app.get("/", (req, res) => {



  res.status(200).json({



    success: true,



    message: "🚀 SAMATKAAR Backend is running successfully!"



  });



});







// ======================================================



// REALTIME STORAGE



// ======================================================







// Random matchmaking waiting players



let waitingQueue = [];







// Currently online players



const onlinePlayers = new Map();







// Socket -> User relation



const socketToUser = new Map();







// Pending direct challenges



const pendingChallenges = new Map();

// Active game room membership survives Socket.IO reconnects.
const activeGameRooms = new Map();







// ======================================================



// HELPER FUNCTIONS



// ======================================================







function normalizeId(value) {



  if (value === undefined || value === null) {



    return "";



  }







  return String(value);



}







// ------------------------------------------------------



// Remove player from matchmaking queue



// ------------------------------------------------------







function removeFromQueue(socketId) {



  waitingQueue = waitingQueue.filter(



    (player) => player.socketId !== socketId



  );



}







// ------------------------------------------------------



// Find online player using MongoDB User ID



// ------------------------------------------------------







function getOnlinePlayerByUserId(userId) {



  const targetId = normalizeId(userId);







  for (const player of onlinePlayers.values()) {



    if (normalizeId(player.userId) === targetId) {



      return player;



    }



  }







  return null;



}







// ------------------------------------------------------



// Generate unique room ID



// ------------------------------------------------------







function makeRoomId(prefix, socketA, socketB) {



  return `${prefix}_${Date.now()}_${socketA}_${socketB}`;



}







// ======================================================



// SOCKET.IO REALTIME SYSTEM



// ======================================================







io.on("connection", (socket) => {



  console.log(



    "✅ Ek user successfully connect ho gaya:",



    socket.id



  );







  // ====================================================




  // ====================================================
  // NOTIFICATION SOCKET - AUTHENTICATED PRIVATE ROOM
  // ====================================================
  socket.on("notification:subscribe", async (data = {}) => {
    try {
      const payload = verifyUserSessionToken(data.token);

      if (
        !payload ||
        !payload.sub ||
        !mongoose.Types.ObjectId.isValid(String(payload.sub))
      ) {
        socket.emit("notification:error", {
          message: "Notification session invalid hai."
        });
        return;
      }

      const exists = await User.exists({ _id: payload.sub });

      if (!exists) {
        socket.emit("notification:error", {
          message: "Notification user nahi mila."
        });
        return;
      }

      socket.join(notificationRoom(payload.sub));
      socket.data.notificationUserId = String(payload.sub);

      socket.emit("notification:subscribed", {
        success: true
      });
    } catch (err) {
      console.error("Notification subscribe error:", err);
      socket.emit("notification:error", {
        message: "Notification realtime connect nahi ho saka."
      });
    }
  });

  // 1. REGISTER PLAYER AS ONLINE



  // ====================================================







  socket.on("register_player", async (data = {}) => {



    try {



      const userId = normalizeId(data.userId);







      if (!userId) {



        socket.emit("realtime_error", {



          message: "User ID missing hai."



        });







        return;



      }







      let dbUser = null;







      if (mongoose.Types.ObjectId.isValid(userId)) {



        dbUser = await User



          .findById(userId)



          .select("_id name coins");



      }







      if (!dbUser) {



        socket.emit("realtime_error", {



          message: "User database mein nahi mila."



        });







        return;



      }







      const player = {



        socketId: socket.id,



        userId: normalizeId(dbUser._id),



        userName: dbUser.name,



        coins: dbUser.coins,







        profilePic:



          data.profilePic ||



          data.profileImage ||



          data.avatar ||



          ""



      };







      onlinePlayers.set(socket.id, player);







      socketToUser.set(



        socket.id,



        player.userId



      );







      socket.emit("player_registered", {



        success: true,



        player



      });







      console.log(



        `🟢 Online: ${player.userName} (${player.userId})`



      );



    } catch (err) {



      console.error(



        "register_player error:",



        err



      );







      socket.emit("realtime_error", {



        message: "Player register nahi ho saka."



      });



    }



  });







  // ====================================================



  // 2. SEARCH PLAYERS



  // ====================================================







  socket.on("search_players", async (data = {}) => {



    try {



      const query = String(



        data.query ||



        data.search ||



        data.userName ||



        ""



      ).trim();







      if (!query) {



        socket.emit("search_players_result", {



          players: []



        });







        socket.emit("player_search_results", {



          players: []



        });







        return;



      }







      const safeQuery = query.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      );







      const users = await User.find({



        name: {



          $regex: safeQuery,



          $options: "i"



        }



      })



        .select("_id name coins")



        .limit(20)



        .lean();







      const requester =



        onlinePlayers.get(socket.id);







      const players = users



        .filter((user) => {



          if (!requester) {



            return true;



          }







          return (



            normalizeId(user._id) !==



            normalizeId(requester.userId)



          );



        })







        .map((user) => {



          const online =



            getOnlinePlayerByUserId(user._id);







          return {



            id: normalizeId(user._id),



            userId: normalizeId(user._id),







            name: user.name,



            userName: user.name,







            coins: user.coins,







            online: Boolean(online),







            socketId:



              online



                ? online.socketId



                : null,







            profilePic:



              online



                ? online.profilePic || ""



                : ""



          };



        });







      /*



        IMPORTANT FIX:



        Old + new frontend dono event names support.



      */







      socket.emit(



        "search_players_result",



        { players }



      );







      socket.emit(



        "player_search_results",



        { players }



      );



    } catch (err) {



      console.error(



        "search_players error:",



        err



      );







      const errorPayload = {



        players: [],



        error: "Players search nahi ho sake."



      };







      socket.emit(



        "search_players_result",



        errorPayload



      );







      socket.emit(



        "player_search_results",



        errorPayload



      );



    }



  });







  // ====================================================



  // 3. SEND FRIEND REQUEST



  // ====================================================







  socket.on(



    "send_friend_request",



    (data = {}) => {



      const sender =



        onlinePlayers.get(socket.id);







      if (!sender) {



        socket.emit(



          "friend_request_error",



          {



            message:



              "Pehle realtime player register karein."



          }



        );







        return;



      }







      /*



        FIX:



        Frontend toUserId bhej raha tha.



        Backend targetUserId expect kar raha tha.



        Ab dono supported.



      */







      const targetUserId =



        data.targetUserId ||



        data.toUserId ||



        data.receiverId ||



        data.userId;







      const target =



        getOnlinePlayerByUserId(



          targetUserId



        );







      if (!target) {
        // Friend requests are allowed even if the other user is offline.
        // The request is stored permanently and will appear when they log in.
        if (!mongoose.Types.ObjectId.isValid(String(targetUserId || ""))) {
          socket.emit("friend_request_error", {
            message: "Invalid player."
          });
          return;
        }

        User.findById(targetUserId)
          .select("_id name")
          .lean()
          .then(async (targetUser) => {
            if (!targetUser) {
              socket.emit("friend_request_error", {
                message: "Yeh player nahi mila."
              });
              return;
            }

            if (String(targetUser._id) === String(sender.userId)) {
              socket.emit("friend_request_error", {
                message: "Aap khud ko friend request nahi bhej sakte."
              });
              return;
            }

            const alreadyPending = await AppNotification.findOne({
              recipientUserId: targetUser._id,
              senderUserId: sender.userId,
              type: "friend_request",
              actionStatus: "pending"
            }).lean();

            if (!alreadyPending) {
              await createAndPushNotification({
                recipientUserId: targetUser._id,
                senderUserId: sender.userId,
                senderName: sender.userName,
                type: "friend_request",
                title: "New friend request",
                message: `${sender.userName} wants to add you as a friend.`,
                data: {
                  senderUserId: String(sender.userId),
                  senderName: sender.userName,
                  profilePic: sender.profilePic || ""
                },
                actionStatus: "pending",
                sourceKey: `friend_${sender.userId}_${targetUser._id}`
              });
            }

            socket.emit("friend_request_sent", {
              success: true,
              targetUserId: String(targetUser._id),
              offline: true,
              message: "Friend request send ho gayi. User ko login par notification mil jayegi."
            });
          })
          .catch((err) => {
            console.error("Offline friend request error:", err);
            socket.emit("friend_request_error", {
              message: "Friend request send nahi ho saki."
            });
          });

        return;
      }







      if (target.socketId === socket.id) {



        socket.emit(



          "friend_request_error",



          {



            message:



              "Aap khud ko friend request nahi bhej sakte."



          }



        );







        return;



      }







      createAndPushNotification({
        recipientUserId: target.userId,
        senderUserId: sender.userId,
        senderName: sender.userName,
        type: "friend_request",
        title: "New friend request",
        message: `${sender.userName} wants to add you as a friend.`,
        data: {
          senderUserId: String(sender.userId),
          senderName: sender.userName,
          profilePic: sender.profilePic || ""
        },
        actionStatus: "pending",
        sourceKey: `friend_${sender.userId}_${target.userId}_${Date.now()}`
      }).catch((err) => {
        console.error("Friend notification save error:", err);
      });

      io.to(target.socketId).emit(



        "friend_request_received",



        {



          from: {



            id: sender.userId,



            userId: sender.userId,







            name: sender.userName,



            userName: sender.userName,







            profilePic:



              sender.profilePic || ""



          }



        }



      );







      socket.emit(



        "friend_request_sent",



        {



          success: true,







          targetUserId:



            target.userId,







          message:



            `${target.userName} ko friend request bhej di gayi.`



        }



      );



    }



  );







  // ====================================================



  // 4. CHALLENGE PLAYER



  // ====================================================







  socket.on(



    "challenge_player",



    (data = {}) => {



      const sender =



        onlinePlayers.get(socket.id);







      if (!sender) {



        socket.emit(



          "challenge_error",



          {



            message:



              "Pehle realtime player register karein."



          }



        );







        return;



      }













      /*



        FIX:



        toUserId bhi accept hoga.



      */







      const targetUserId =



        data.targetUserId ||



        data.toUserId ||



        data.opponentId ||



        data.receiverId;







      const target =



        getOnlinePlayerByUserId(



          targetUserId



        );







      if (!target) {



        socket.emit(



          "challenge_error",



          {



            message:



              "Opponent abhi online nahi hai."



          }



        );







        return;



      }







      if (target.socketId === socket.id) {



        socket.emit(



          "challenge_error",



          {



            message:



              "Aap khud ko challenge nahi kar sakte."



          }



        );







        return;



      }







      const game = String(



        data.game ||



        data.gameType ||



        "ludo"



      ).toLowerCase();







      const betCoins = Math.max(



        0,



        Number(data.betCoins) || 0



      );







      const challengeId =



        `challenge_${Date.now()}_${socket.id}_${target.socketId}`;







      /*



        FIX:



        Challenge ko backend memory mein save karo.



        Is se Accept button ko sirf challengeId bhejna



        pade to bhi backend original challenger,



        game aur bet identify kar lega.



      */







      pendingChallenges.set(



        challengeId,



        {



          challengeId,







          challengerUserId:



            sender.userId,







          targetUserId:



            target.userId,







          game,



          betCoins,







          createdAt: Date.now()



        }



      );







      createAndPushNotification({
        recipientUserId: target.userId,
        senderUserId: sender.userId,
        senderName: sender.userName,
        type: "challenge",
        title: "New game challenge",
        message: `${sender.userName} challenged you to ${game === "pool" ? "8 Ball Pool" : "Ludo"}${betCoins > 0 ? ` for ${betCoins} coins` : ""}.`,
        data: {
          challengeId,
          challengerUserId: String(sender.userId),
          challengerName: sender.userName,
          game,
          betCoins
        },
        actionStatus: "pending",
        sourceKey: challengeId
      }).catch((err) => {
        console.error("Challenge notification save error:", err);
      });

      // Opponent ko challenge bhejo







      io.to(target.socketId).emit(



        "challenge_received",



        {



          challengeId,







          challengerUserId:



            sender.userId,







          fromUserId:



            sender.userId,







          fromName:



            sender.userName,







          game,



          betCoins,







          challenger: {



            id:



              sender.userId,







            userId:



              sender.userId,







            name:



              sender.userName,







            userName:



              sender.userName,







            socketId:



              sender.socketId,







            profilePic:



              sender.profilePic || ""



          }



        }



      );







      // Sender confirmation







      socket.emit(



        "challenge_sent",



        {



          success: true,







          challengeId,







          game,



          betCoins,







          opponent: {



            id:



              target.userId,







            name:



              target.userName



          }



        }



      );







      console.log(



        `⚔️ Challenge: ${sender.userName} -> ${target.userName} | ${game} | ${betCoins}`



      );



    }



  );







  // ====================================================



  // 5. ACCEPT CHALLENGE



  // ====================================================







  socket.on(



    "accept_challenge",



    (data = {}) => {



      const acceptingPlayer =



        onlinePlayers.get(socket.id);







      if (!acceptingPlayer) {



        socket.emit(



          "challenge_error",



          {



            message:



              "Player realtime system mein registered nahi hai."



          }



        );







        return;



      }







      /*



        Challenge ID se original challenge retrieve.



      */







      const savedChallenge =



        data.challengeId



          ? pendingChallenges.get(



              data.challengeId



            )



          : null;







      const challengerUserId =



        data.challengerUserId ||



        savedChallenge?.challengerUserId ||



        data.fromUserId ||



        (



          data.challenger &&



          (



            data.challenger.userId ||



            data.challenger.id



          )



        );







      const challenger =



        getOnlinePlayerByUserId(



          challengerUserId



        );







      if (!challenger) {



        socket.emit(



          "challenge_error",



          {



            message:



              "Challenge bhejne wala player offline ho gaya hai."



          }



        );







        return;



      }







      const game = String(



        data.game ||



        data.gameType ||



        savedChallenge?.game ||



        "ludo"



      ).toLowerCase();







      const betCoins = Math.max(



        0,



        Number(



          data.betCoins ??



          savedChallenge?.betCoins



        ) || 0



      );







      const roomId =



        makeRoomId(



          "challenge_room",



          challenger.socketId,



          socket.id



        );







      const challengerSocket =



        io.sockets.sockets.get(



          challenger.socketId



        );







      if (!challengerSocket) {



        socket.emit(



          "challenge_error",



          {



            message:



              "Challenger disconnect ho gaya hai."



          }



        );







        return;



      }







      /*



        BOTH PLAYERS SAME SOCKET.IO ROOM



      */







      challengerSocket.join(



        roomId



      );







      socket.join(



        roomId



      );







      removeFromQueue(



        challenger.socketId



      );







      removeFromQueue(



        socket.id



      );







      const matchData = {



        roomId,







        game,







        betCoins,







        matchType:



          "challenge",







        player1: {



          id:



            challenger.userId,







          name:



            challenger.userName,







          socketId:



            challenger.socketId,







          profilePic:



            challenger.profilePic || ""



        },







        player2: {



          id:



            acceptingPlayer.userId,







          name:



            acceptingPlayer.userName,







          socketId:



            acceptingPlayer.socketId,







          profilePic:



            acceptingPlayer.profilePic || ""



        }



      };







      /*



        Dono users ko same match information.



      */







      activeGameRooms.set(String(roomId), new Set([
        normalizeId(challenger.userId),
        normalizeId(acceptingPlayer.userId)
      ]));

      io.to(roomId).emit(



        "challenge_accepted",



        matchData



      );







      io.to(roomId).emit(



        "match_found",



        matchData



      );







      if (data.challengeId) {



        pendingChallenges.delete(



          data.challengeId



        );



      }







      if (data.challengeId) {
        AppNotification.updateMany(
          {
            recipientUserId: acceptingPlayer.userId,
            type: "challenge",
            sourceKey: data.challengeId
          },
          {
            $set: {
              read: true,
              actionStatus: "accepted"
            }
          }
        ).catch((err) => {
          console.error("Challenge notification accept sync error:", err);
        });
      }

      createAndPushNotification({
        recipientUserId: challenger.userId,
        senderUserId: acceptingPlayer.userId,
        senderName: acceptingPlayer.userName,
        type: "challenge_accepted",
        title: "Challenge accepted",
        message: `${acceptingPlayer.userName} accepted your ${game === "pool" ? "8 Ball Pool" : "Ludo"} challenge.`,
        data: {
          roomId,
          game,
          betCoins,
          challengeId: data.challengeId || ""
        },
        actionStatus: "accepted",
        sourceKey: data.challengeId || String(roomId)
      }).catch((err) => {
        console.error("Challenge accepted notification error:", err);
      });

      console.log(



        `⚔️ Challenge accepted: ${challenger.userName} VS ${acceptingPlayer.userName} | ${game} | Room: ${roomId}`



      );



    }



  );







  // ====================================================



  // 6. REJECT CHALLENGE



  // ====================================================







  socket.on(



    "reject_challenge",



    (data = {}) => {



      const savedChallenge =



        data.challengeId



          ? pendingChallenges.get(



              data.challengeId



            )



          : null;







      const challengerUserId =



        data.challengerUserId ||



        savedChallenge?.challengerUserId ||



        data.fromUserId ||



        (



          data.challenger &&



          (



            data.challenger.userId ||



            data.challenger.id



          )



        );







      const challenger =



        getOnlinePlayerByUserId(



          challengerUserId



        );







      if (challenger) {



        io.to(



          challenger.socketId



        ).emit(



          "challenge_rejected",



          {



            message:



              "Opponent ne challenge decline kar diya."



          }



        );



      }







      if (data.challengeId) {



        pendingChallenges.delete(



          data.challengeId



        );



      }







      const rejectingPlayer = onlinePlayers.get(socket.id);

      if (data.challengeId && rejectingPlayer) {
        AppNotification.updateMany(
          {
            recipientUserId: rejectingPlayer.userId,
            type: "challenge",
            sourceKey: data.challengeId
          },
          {
            $set: {
              read: true,
              actionStatus: "rejected"
            }
          }
        ).catch((err) => {
          console.error("Challenge notification reject sync error:", err);
        });
      }

      if (challenger && rejectingPlayer) {
        createAndPushNotification({
          recipientUserId: challenger.userId,
          senderUserId: rejectingPlayer.userId,
          senderName: rejectingPlayer.userName,
          type: "challenge_rejected",
          title: "Challenge declined",
          message: `${rejectingPlayer.userName} declined your game challenge.`,
          data: {
            challengeId: data.challengeId || ""
          },
          actionStatus: "rejected",
          sourceKey: data.challengeId || ""
        }).catch((err) => {
          console.error("Challenge rejected notification error:", err);
        });
      }

      socket.emit(



        "challenge_rejected_confirmation",



        {



          success: true



        }



      );



    }



  );







  // ====================================================



  // 7. RANDOM MATCHMAKING



  // ====================================================







  socket.on(



    "find_random_match",



    (data = {}) => {



      const registeredPlayer =



        onlinePlayers.get(



          socket.id



        );







      const userId =



        normalizeId(



          data.userId ||



          (



            registeredPlayer &&



            registeredPlayer.userId



          )



        );







      const userName =



        data.userName ||



        data.name ||



        (



          registeredPlayer &&



          registeredPlayer.userName



        );







      const game =



        String(



          data.game ||



          data.gameType ||



          "ludo"



        ).toLowerCase();







      const betCoins =



        Math.max(



          0,



          Number(



            data.betCoins



          ) || 0



        );







      if (



        !userId ||



        !userName



      ) {



        socket.emit(



          "match_error",



          {



            message:



              "User information missing hai."



          }



        );







        return;



      }







      /*



        Safety:



        stale entry remove kar dete hain agar same



        socket kisi purani queue state mein reh gaya ho.



      */







      waitingQueue =



        waitingQueue.filter(



          (player) => {



            if (



              player.socketId ===



              socket.id



            ) {



              return false;



            }







            const oldSocket =



              io.sockets.sockets.get(



                player.socketId



              );







            return Boolean(oldSocket);



          }



        );







      console.log(



        `🔍 ${userName} | ${game} | ${betCoins} coins matchmaking queue mein aa gaya hai.`



      );







      // ----------------------------------------



      // SAME GAME + SAME BET OPPONENT



      // ----------------------------------------







      const existingIndex =



        waitingQueue.findIndex(



          (player) =>



            player.socketId !==



              socket.id &&







            normalizeId(



              player.userId



            ) !== userId &&







            Number(



              player.betCoins



            ) === Number(



              betCoins



            ) &&







            String(



              player.game



            ).toLowerCase() ===



              game &&







            io.sockets.sockets.has(



              player.socketId



            )



        );







      // ========================================



      // MATCH FOUND



      // ========================================







      if (



        existingIndex !== -1



      ) {



        const opponent =



          waitingQueue.splice(



            existingIndex,



            1



          )[0];







        const opponentSocket =



          io.sockets.sockets.get(



            opponent.socketId



          );







        if (!opponentSocket) {



          /*



            Opponent stale nikla.



            Current user ko queue mein daal do.



          */







          waitingQueue.push({



            socketId:



              socket.id,







            userId,







            userName,







            game,







            betCoins



          });







          socket.emit(



            "waiting_for_opponent",



            {



              message:



                "Opponent disconnect ho gaya. Naya opponent search ho raha hai...",







              game,



              betCoins



            }



          );







          return;



        }







        const roomId =



          makeRoomId(



            "room",



            socket.id,



            opponent.socketId



          );







        /*



          Both players join SAME ROOM.



        */







        socket.join(



          roomId



        );







        opponentSocket.join(



          roomId



        );







        /*



          Ensure current player queue mein



          duplicate na rahe.



        */







        removeFromQueue(



          socket.id



        );







        const currentProfile =



          onlinePlayers.get(



            socket.id



          );







        const opponentProfile =



          onlinePlayers.get(



            opponent.socketId



          );







        const matchData = {



          roomId,







          game,







          betCoins,







          matchType:



            "random",







          player1: {



            id:



              userId,







            userId,







            name:



              userName,







            userName,







            socketId:



              socket.id,







            profilePic:



              (



                currentProfile &&



                currentProfile.profilePic



              ) || ""



          },







          player2: {



            id:



              opponent.userId,







            userId:



              opponent.userId,







            name:



              opponent.userName,







            userName:



              opponent.userName,







            socketId:



              opponent.socketId,







            profilePic:



              (



                opponentProfile &&



                opponentProfile.profilePic



              ) || ""



          }



        };







        activeGameRooms.set(String(roomId), new Set([
          normalizeId(userId),
          normalizeId(opponent.userId)
        ]));

        /*



          MOST IMPORTANT:



          SAME match_found event dono browsers ko.



        */







        io.to(



          roomId



        ).emit(



          "match_found",



          matchData



        );







        console.log(



          `🎮 Match Start! ${game} | Room: ${roomId} | ${userName} VS ${opponent.userName} | Bet: ${betCoins}`



        );







        return;



      }







      // ========================================



      // NO MATCH - WAIT



      // ========================================







      waitingQueue.push({



        socketId:



          socket.id,







        userId,







        userName,







        game,







        betCoins



      });







      socket.emit(



        "waiting_for_opponent",



        {



          message:



            "Opponent ki talash ki ja rahi hai...",







          game,







          betCoins



        }



      );







      console.log(



        `⏳ ${userName} ${game} ke liye queue mein wait kar raha hai.`



      );



    }



  );







  // ====================================================



  // 8. CANCEL RANDOM MATCH



  // ====================================================







  socket.on(



    "cancel_queue",



    () => {



      removeFromQueue(



        socket.id



      );







      socket.emit(



        "queue_cancelled",



        {



          message:



            "Matchmaking cancel kar di gayi."



        }



      );







      console.log(



        `🚫 Matchmaking cancelled: ${socket.id}`



      );



    }



  );







  // ====================================================



  // 9. GAME ROOM EVENTS



  // ====================================================







  socket.on("rejoin_game_room", (data = {}) => {
    const roomId = String(data.roomId || "").trim();
    const userId = normalizeId(data.userId);

    if (!roomId || !userId) {
      return;
    }

    const allowedUsers = activeGameRooms.get(roomId);

    if (!allowedUsers || !allowedUsers.has(userId)) {
      socket.emit("realtime_error", {
        message: "Game room reconnect verify nahi ho saka."
      });
      return;
    }

    socket.join(roomId);
    socketToUser.set(socket.id, userId);

    socket.emit("game_room_rejoined", {
      roomId,
      serverNow: Date.now()
    });

    socket.to(roomId).emit("opponent_reconnected", {
      roomId,
      userId
    });
  });


  socket.on(



    "game_event",



    (data = {}) => {



      const {



        roomId,



        type,



        payload



      } = data;







      if (



        !roomId ||



        !type



      ) {



        return;



      }







      /*



        Security:



        sender us room ka member hona chahiye.



      */







      if (



        !socket.rooms.has(



          roomId



        )



      ) {



        socket.emit(



          "realtime_error",



          {



            message:



              "Aap is game room ka hissa nahi hain."



          }



        );







        return;



      }







      /*



        Sender ke ilawa room ke opponent



        ko game action bhejo.



      */







      socket



        .to(roomId)



        .emit(



          "game_event",



          {



            roomId,







            type,







            payload,







            fromSocketId:



              socket.id



          }



        );



    }



  );







  // ====================================================



  // 10. LEAVE GAME ROOM



  // ====================================================







  socket.on(



    "leave_game_room",



    (data = {}) => {



      const roomId =



        data.roomId;







      if (



        !roomId ||



        !socket.rooms.has(



          roomId



        )



      ) {



        return;



      }







      socket



        .to(roomId)



        .emit(



          "opponent_left_game",



          {



            socketId:



              socket.id,







            message:



              "Opponent game se nikal gaya."



          }



        );







      socket.leave(



        roomId



      );

      activeGameRooms.delete(String(roomId));



    }



  );







  // ====================================================



  // 11. DISCONNECT



  // ====================================================







  socket.on(



    "disconnect",



    () => {



      console.log(



        "❌ User disconnect ho gaya:",



        socket.id



      );







      // Matchmaking queue clean



      removeFromQueue(



        socket.id



      );







      const userId =



        socketToUser.get(



          socket.id



        );







      // Online players clean



      onlinePlayers.delete(



        socket.id



      );







      socketToUser.delete(



        socket.id



      );







      /*



        Is disconnected player ke pending



        challenges bhi clean kar do.



      */







      for (



        const [



          challengeId,



          challenge



        ] of pendingChallenges



      ) {



        if (



          normalizeId(



            challenge.challengerUserId



          ) === normalizeId(



            userId



          ) ||



          normalizeId(



            challenge.targetUserId



          ) === normalizeId(



            userId



          )



        ) {



          pendingChallenges.delete(



            challengeId



          );



        }



      }







      socket.broadcast.emit(



        "player_offline",



        {



          userId:



            userId || null,







          socketId:



            socket.id



        }



      );



    }



  );



});





// ======================================================

// LUCKY DRAW - AUTOMATIC ROUND CHECK

// ======================================================



const LUCKY_DRAW_CHECK_INTERVAL =

  60 * 1000;



setInterval(async () => {

  try {

    await getCurrentLuckyRound();

  } catch (err) {

    console.error(

      "Lucky Draw automatic round check error:",

      err

    );

  }

}, LUCKY_DRAW_CHECK_INTERVAL);



// ======================================================



// SERVER INITIALIZATION



// ======================================================







// ======================================================

// LUCKY DRAW - STARTUP CHECK

// ======================================================



getCurrentLuckyRound()

  .then((round) => {

    console.log(

      `🎟️ Active Lucky Draw: ${round.roundId}`

    );

  })

  .catch((err) => {

    console.error(

      "Lucky Draw startup error:",

      err

    );

  });





// ======================================================

// SERVER INITIALIZATION

// ======================================================



server.listen(

  PORT,

  "0.0.0.0",

  () => {

    console.log(

      `🚀 Server is running smoothly on port ${PORT}`

    );

  }

);