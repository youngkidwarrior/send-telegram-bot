// Game module to handle all game-related functionality
open Bindings
open Telegraf

// Type for a player with SendTag
type player = {
  sendtag: string,
  userId: userId,
  callbackQueryId: callbackQueryId
}

// Game states
type rec state =
  | Initializing
  | Collecting({
      // Common fields
      players: array<player>,
      winningNumber: int,
      amount: bigint,
      baseAmount: bigint,
      surgeAmount: bigint,
      master: Telegraf.User.t,
      // Collecting-specific fields
      maxPlayers: int,
      messageId: Telegraf.messageId,
    })
  | Completed({
      // Common fields
      players: array<player>,
      winningNumber: int,
      amount: bigint,
      baseAmount: bigint,
      surgeAmount: bigint,
      master: Telegraf.User.t,
      // Completed-specific field
      winner: player,
    })
  | Cancelled(cancelReason)

and cancelReason =
  | AdminCancelled(Telegraf.User.t)
  | MasterCancelled
  | Expired
  | Error(string)

// Helper type for pending player joins
type pendingJoin = {
  players: array<player>,
  timeout: option<Js.Global.timeoutId>,
}

// State for tracking surges
type surge = {
  updatedAt: float,
  multiplier: int
}

// Error types
type error =
  | NoActiveGame
  | NoSendTag
  | AlreadyJoined
  | GameFull
  | InternalError(string)

// Results
type joinResult =
  | Success(int) // Position
  | Error(error)

// Constants that affect gameplay
let minPlayers = 3
let maxPlayers = 20
let minGuessAmount = 50n
let surgeCooldown = 60000 // 1 minute in milliseconds
let surgeIncrease = 50n // Amount to increase by each time

// Helper functions for game management
let formatAmount = amount => {
  // Format number with commas
  let pattern = "\\B(?=(\\d{3})+(?!\\d))"
  BigInt.toString(amount)
  ->String.replaceRegExp(RegExp.fromString(pattern, ~flags="g"), ",")
}

let formatPlayerList = players => {
  players
  ->Array.map(player => player.sendtag)
  ->Array.join(", ")
}

// Check if a surge is active
let isSurgeActive = surge => Date.now() -. surge.updatedAt < surgeCooldown->Float.fromInt

// Generate message text for game state
let gameStateText = state => {
  switch state {
  | Initializing => "Initializing game..."
  | Collecting(c) => {
      let playerCount = c.players->Array.length
      let playerList = c.players->formatPlayerList
      let surgeText = c.surgeAmount > 0n ? "\n📈 Send Surge: " ++ BigInt.toString(c.surgeAmount / surgeIncrease) : ""

      c.master->User.first_name ++ " is sending " ++ (c.amount->formatAmount) ++ " SEND\n" ++
      Int.toString(playerCount) ++ " / " ++ Int.toString(c.maxPlayers) ++ " players\n\n" ++
      playerList ++ surgeText
    }
  | Completed(c) => {
      "🎉 Winner\n# " ++ Int.toString(c.winningNumber) ++ " out of " ++ Int.toString(c.players->Array.length) ++ "!"
    }
  | Cancelled(reason) => {
      switch reason {
      | AdminCancelled(user) => `🎲 Game killed by Admin ${user->User.first_name}`
      | MasterCancelled => `🎲 Game killed by creator`
      | Expired => `🎲 Game expired`
      | Error(msg) => `❌ Game error: ${msg}`
      }
    }
  }
}

// Create a new game
let createGame = (chatId: Telegraf.chatId, master: Telegraf.User.t, ~maxPlayers=10, ~baseAmount=minGuessAmount, ~surge=?) => {
  // Generate random winning number (1-based)
  let winningNumber = {
    // Convert maxPlayers to float for the calculation
    let maxPlayersFloat = maxPlayers->Int.toFloat
    // Do the float calculation
    let result = Math.random() *. maxPlayersFloat -. 0.001 +. 1.0
    // Floor the result and convert back to int
    result->Math.floor->Int.fromFloat
  }

  // Calculate amount with surge if provided
  let surgeAmount = switch surge {
    | Some(s) if isSurgeActive(s) => BigInt.fromInt(s.multiplier) * surgeIncrease
    | _ => 0n
  }

  // Calculate full amount
  let totalAmount = baseAmount + surgeAmount

  let state = Collecting({
    // Common fields
    winningNumber,
    players: [],
    amount: totalAmount,
    baseAmount,
    surgeAmount,
    master,
    // Collecting-specific fields
    maxPlayers,
    messageId: Telegraf.IntId.unsafeOfInt(0), // Placeholder, will be updated
  })

  (chatId, state)
}

// Add a player to the game
let addPlayer = (state, player) => {
  switch state {
  | Collecting(collecting) =>
      let players = collecting.players->Array.concat([player])
      let newState = if players->Array.length >= collecting.maxPlayers {
        // Game is full - determine winner
        let winner = switch players->Array.get(collecting.winningNumber - 1) {
          | Some(player) => player
          | None => failwith("Winner index out of bounds") // This should never happen due to our length check
        }
        Completed({
          // Copy common fields
          winningNumber: collecting.winningNumber,
          amount: collecting.amount,
          baseAmount: collecting.baseAmount,
          surgeAmount: collecting.surgeAmount,
          master: collecting.master,
          // Updated fields
          players,
          // Add winner
          winner,
        })
      } else {
        // Game continues
        Collecting({...collecting, players})
      }
      (newState, Array.indexOf(players, player) + 1)
  | _ => (state, -1) // Cannot add player to a non-collecting game
  }
}

// Cancel a game
let cancelGame = (state, reason) => {
  switch state {
  | Collecting(_) => Cancelled(reason)
  | _ => state // Already completed or cancelled
  }
}

// Format a completed game's winner message
let formatWinnerMessage = state => {
  switch state {
  | Completed(c) => {
      let escapedMasterName = c.master->User.first_name->String.replaceRegExp(RegExp.fromString("_", ~flags="g"), "\\_")
      let escapedSendtag = c.winner.sendtag->String.replaceRegExp(RegExp.fromString("_", ~flags="g"), "\\_")
      let surgeText = c.surgeAmount > 0n
        ? "+ " ++ (c.surgeAmount->formatAmount) ++ " SEND during Send Surge"
        : ""

      "➡️ [‎](tg://user?id=" ++ Int.toString(c.master->User.id->Telegraf.IntId.toInt) ++ ") " ++ escapedMasterName ++ " send " ++
      (c.amount->formatAmount) ++ " SEND to " ++ escapedSendtag ++ " [‎](tg://user?id=" ++
      Int.toString(c.winner.userId->Telegraf.IntId.toInt) ++ ")\n\n" ++ surgeText
    }
  | _ => ""
  }
}
