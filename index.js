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

// ------------------------------------------------------
// ADMIN SECURITY
// ------------------------------------------------------
// Railway Variables mein ADMIN_DEPOSIT_KEY set karo.
// Admin approve/reject request mein:
// x-admin-key: YOUR_SECRET_KEY
// ------------------------------------------------------

function requireDepositAdmin(req, res, next) {
  const configuredKey = String(process.env.ADMIN_DEPOSIT_KEY || "");
  const suppliedKey = String(req.headers["x-admin-key"] || "");

  if (!configuredKey) {
    return res.status(503).json({
      success: false,
      error: "ADMIN_DEPOSIT_KEY server par configure nahi hai."
    });
  }

  const configuredBuffer = Buffer.from(configuredKey);
  const suppliedBuffer = Buffer.from(suppliedKey);

  const valid =
    configuredBuffer.length === suppliedBuffer.length &&
    crypto.timingSafeEqual(configuredBuffer, suppliedBuffer);

  if (!valid) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized admin request."
    });
  }

  next();
}

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







      user: {



        id: newUser._id,



        name: newUser.name,



        phone: newUser.phone,



        coins: newUser.coins



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







      user: {



        id: user._id,



        name: user.name,



        phone: user.phone,



        coins: user.coins



      }



    });



  } catch (err) {



    res.status(500).json({



      error: "Server error: " + err.message



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

// Server-authoritative game turn clocks.
// The browser only DISPLAYS this clock; the server owns the deadline.
const gameRooms = new Map();
const TURN_DURATION_MS = 40 * 1000;

function createServerTurnState(roomId, player1, player2) {
  const players = [player1, player2].filter(Boolean);
  if (players.length < 2) return null;

  // Server chooses once, so both browsers always get the same first turn.
  const currentTurnIndex = crypto.randomInt(0, players.length);
  const now = Date.now();
  const state = {
    roomId,
    players: players.map((p) => ({
      userId: normalizeId(p.userId || p.id),
      socketId: p.socketId
    })),
    currentTurnIndex,
    turnNumber: 1,
    turnStartedAt: now,
    turnEndsAt: now + TURN_DURATION_MS,
    timer: null
  };

  gameRooms.set(roomId, state);
  scheduleServerTurnTimeout(roomId);
  return state;
}

function publicTurnState(state) {
  if (!state) return null;
  const current = state.players[state.currentTurnIndex];
  return {
    roomId: state.roomId,
    currentTurnUserId: current?.userId || "",
    currentTurnSocketId: current?.socketId || "",
    turnNumber: state.turnNumber,
    turnStartedAt: state.turnStartedAt,
    turnEndsAt: state.turnEndsAt,
    serverNow: Date.now(),
    turnDurationMs: TURN_DURATION_MS
  };
}

function scheduleServerTurnTimeout(roomId) {
  const state = gameRooms.get(roomId);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);

  const delay = Math.max(0, state.turnEndsAt - Date.now());
  state.timer = setTimeout(() => {
    const latest = gameRooms.get(roomId);
    if (!latest) return;

    const expiredPlayer = latest.players[latest.currentTurnIndex];
    io.to(roomId).emit("turn_timeout", {
      ...publicTurnState(latest),
      expiredUserId: expiredPlayer?.userId || "",
      expiredSocketId: expiredPlayer?.socketId || ""
    });

    advanceServerTurn(roomId, "timeout");
  }, delay + 10);
}

function advanceServerTurn(roomId, reason = "move_complete") {
  const state = gameRooms.get(roomId);
  if (!state) return null;
  if (state.timer) clearTimeout(state.timer);

  state.currentTurnIndex = (state.currentTurnIndex + 1) % state.players.length;
  state.turnNumber += 1;
  state.turnStartedAt = Date.now();
  state.turnEndsAt = state.turnStartedAt + TURN_DURATION_MS;

  scheduleServerTurnTimeout(roomId);
  const turn = publicTurnState(state);
  io.to(roomId).emit("turn_state", { ...turn, reason });
  return turn;
}

function destroyServerTurnState(roomId) {
  const state = gameRooms.get(roomId);
  if (state?.timer) clearTimeout(state.timer);
  gameRooms.delete(roomId);
}








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



        socket.emit(



          "friend_request_error",



          {



            message:



              "Yeh player abhi online nahi hai."



          }



        );







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







      const turnState = createServerTurnState(roomId, matchData.player1, matchData.player2);
      if (turnState) Object.assign(matchData, publicTurnState(turnState));

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







        /*



          MOST IMPORTANT:



          SAME match_found event dono browsers ko.



        */







        const turnState = createServerTurnState(roomId, matchData.player1, matchData.player2);
        if (turnState) Object.assign(matchData, publicTurnState(turnState));

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



  // 8B. SERVER-AUTHORITATIVE TURN/TIMER EVENTS
  socket.on("request_turn_state", ({ roomId } = {}) => {
    if (!roomId || !socket.rooms.has(roomId)) return;
    const state = gameRooms.get(roomId);
    if (state) socket.emit("turn_state", { ...publicTurnState(state), reason: "sync" });
  });

  socket.on("end_turn", ({ roomId, turnNumber } = {}) => {
    if (!roomId || !socket.rooms.has(roomId)) return;
    const state = gameRooms.get(roomId);
    if (!state) return;

    const current = state.players[state.currentTurnIndex];
    if (current?.socketId !== socket.id) {
      socket.emit("realtime_error", { message: "Abhi aapki turn nahi hai." });
      return;
    }
    if (Number(turnNumber) !== state.turnNumber) {
      socket.emit("turn_state", { ...publicTurnState(state), reason: "stale_turn_rejected" });
      return;
    }
    advanceServerTurn(roomId, "player_finished");
  });

  // ====================================================
  // 9. GAME ROOM EVENTS



  // ====================================================







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

      for (const [roomId, state] of gameRooms.entries()) {
        if (state.players.some((p) => p.socketId === socket.id)) {
          socket.to(roomId).emit("opponent_disconnected", { socketId: socket.id });
          destroyServerTurnState(roomId);
        }
      }







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