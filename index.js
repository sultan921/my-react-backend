const express = require("express");
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
mongoose.connect(MONGO_URI)
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

      onlinePlayers.set(
        socket.id,
        player
      );

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

        return;
      }

      // Regex special characters escape
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

        // Apna account search result mein na dikhao
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
            getOnlinePlayerByUserId(
              user._id
            );

          return {

            id: normalizeId(user._id),

            userId:
              normalizeId(user._id),

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

      socket.emit(
        "search_players_result",
        {
          players
        }
      );

    } catch (err) {

      console.error(
        "search_players error:",
        err
      );

      socket.emit(
        "search_players_result",
        {
          players: [],
          error: "Players search nahi ho sake."
        }
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

      const targetUserId =

        data.targetUserId ||
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

      if (
        target.socketId ===
        socket.id
      ) {

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

            userId:
              sender.userId,

            name:
              sender.userName,

            userName:
              sender.userName,

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

      const targetUserId =

        data.targetUserId ||
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

      if (
        target.socketId ===
        socket.id
      ) {

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

      // Opponent ko challenge bhejo
      io.to(target.socketId).emit(
        "challenge_received",
        {

          challengeId,

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

      // Sender ko confirmation
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

      const challengerUserId =

        data.challengerUserId ||

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
        "ludo"
      ).toLowerCase();

      const betCoins = Math.max(
        0,
        Number(data.betCoins) || 0
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

      io.to(roomId).emit(
        "challenge_accepted",
        matchData
      );

      io.to(roomId).emit(
        "match_found",
        matchData
      );

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

      const challengerUserId =

        data.challengerUserId ||

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

      console.log(
        `🔍 ${userName} | ${game} | ${betCoins} coins matchmaking queue mein aa gaya hai.`
      );

      // ----------------------------------------
      // Already waiting?
      // ----------------------------------------

      const alreadyWaiting =
        waitingQueue.some(
          (player) =>
            player.socketId ===
            socket.id
        );

      if (
        alreadyWaiting
      ) {

        socket.emit(
          "waiting_for_opponent",
          {

            message:
              "Aap already opponent ka wait kar rahe hain...",

            game,

            betCoins

          }
        );

        return;
      }

      // ----------------------------------------
      // Same GAME + Same BET opponent
      // ----------------------------------------

      const existingIndex =
        waitingQueue.findIndex(
          (player) =>

            player.socketId !==
              socket.id &&

            player.betCoins ===
              betCoins &&

            player.game ===
              game

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

        if (
          !opponentSocket
        ) {

          socket.emit(
            "match_error",
            {
              message:
                "Opponent disconnect ho gaya. Dobara try karein."
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

        socket.join(
          roomId
        );

        opponentSocket.join(
          roomId
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

            name:
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

            name:
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

        io.to(
          roomId
        ).emit(
          "match_found",
          matchData
        );

        console.log(
          `🎮 Match Start! ${game} | Room: ${roomId} | ${userName} VS ${opponent.userName} | Bet: ${betCoins}`
        );

      }

      // ========================================
      // NO MATCH - WAIT
      // ========================================

      else {

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

  /*
    Is event ko Ludo aur Pool ke
    realtime moves bhejne ke liye
    use kiya ja sakta hai.

    Example:

    socket.emit("game_event", {
      roomId,
      type: "DICE_ROLL",
      payload: {
        dice: 6
      }
    });

    Doosre player ko event milega.
  */

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

      // Security:
      // Player us room ka member hona chahiye
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

      // Sender ke ilawa opponent ko event bhejo
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

      // Dusre clients ko offline information
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