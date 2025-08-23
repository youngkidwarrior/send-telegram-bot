open Bindings
open Telegraf

// Type definitions first
type token = {address: string, decimals: bigint, symbol: string}

// Error types for command parsing and validation
type error = string

// Command options for each command type
type guessOptions = {
  maxNumber?: int, // Optional max number of players
  baseAmount?: bigint, // Optional base amount for the guess
}

// Send command options
type sendOptions = {
  recipient: string,
  amount?: string,
  note?: string,
}

// Define the command variants
type t =
  | Guess(guessOptions)
  | Send(sendOptions)
  | Kill
  | Help

let send = {
  address: "0xEab49138BA2Ea6dd776220fE26b7b8E446638956",
  decimals: 18n,
  symbol: "SEND",
}

let baseUrl = "https://send.app/send/"
let confirmUrl = "https://send.app/send/confirm/"

let formatAmount = amount => {
  let divisor = 10n ** send.decimals
  let integer = amount / divisor
  BigInt.toString(integer)
}

// Parse a decimal amount string into base units (bigint)
// Follow the same style as cleanSendtag (no explicit return annotation; return Some/None)
let parseAmountToUnits = (s: string) => {
  let s1 = s->String.trim
  if s1 == "" {
    None
  } else {
    let parts = s1->String.split(".")
    switch parts->Array.length {
    | 1 =>
      switch parts[0] {
      | Some(intStr) =>
        switch BigInt.fromString(intStr) {
        | Some(intPart) => Some(intPart * (10n ** send.decimals))
        | None => None
        }
      | None => None
      }
    | 2 =>
      let intStr = parts[0]->Option.getOr("")
      let fracRaw = parts[1]->Option.getOr("")
      let digits = RegExp.fromString("^\\d+$")
      let intOk = intStr == "" || intStr->String.match(digits)->Option.isSome
      let fracOk = fracRaw == "" || fracRaw->String.match(digits)->Option.isSome
      if !intOk || !fracOk {
        None
      } else {
        let decimalsInt =
          send.decimals->BigInt.toString->Int.fromString->Option.getOr(18)
        let fracLimited =
          if fracRaw->String.length > decimalsInt {
            fracRaw->String.slice(~start=0, ~end=decimalsInt)
          } else {
            fracRaw
          }
        let len = fracLimited->String.length
        let padZeros = decimalsInt - len
        let fracUnits =
          if fracLimited == "" {
            0n
          } else {
            switch BigInt.fromString(fracLimited) {
            | Some(bi) =>
              let mulPow = 10n ** BigInt.fromInt(padZeros)
              bi * mulPow
            | None => 0n
            }
          }
        let intUnits =
          if intStr == "" {
            0n
          } else {
            switch BigInt.fromString(intStr) {
            | Some(bi) => bi * (10n ** send.decimals)
            | None => 0n
            }
          }
        Some(intUnits + fracUnits)
      }
    | _ => None
    }
  }
}

// Generate a URL for sending tokens
let generateSendUrl = (command: sendOptions) =>
  switch command {
  | {recipient, amount: ?Some(amountStr)} =>
    switch parseAmountToUnits(amountStr) {
    | Some(parsed) =>
      `${confirmUrl}?idType=tag&recipient=${recipient}&amount=${parsed->BigInt.toString}&sendToken=${send.address}`
    | None =>
      `${baseUrl}?idType=tag&recipient=${recipient}&sendToken=${send.address}`
    }
  | {recipient, amount: ?None} =>
    `${baseUrl}?idType=tag&recipient=${recipient}&sendToken=${send.address}`
  }

// Generate text for send command
let generateSendText = (recipient, amount, ~note=?) => {
  let formattedAmount = formatAmount(amount)

  // Base messages
  let baseMessage = `Sending ${formattedAmount} to ${recipient}`

  // Add note if provided
  switch note {
  | None => baseMessage
  | Some(noteText) => `${baseMessage}\nNote: ${noteText}`
  }
}

// Helper function to parse integers from strings
let parseInt = str => {
  // Int.fromString already returns an option, no need to wrap in another one
  Int.fromString(str)
}

// Parse guess command arguments - SEND token only. Args: [/guess] [maxPlayers?] [baseAmountUnits?]
let parseGuessCommand = args => {
  let maybeMax = args[0]->Option.flatMap(Int.fromString(_))
  let maybeBaseAmount = args[1]->Option.flatMap(BigInt.fromString(_))

  let randomMax = {
    let range = Game.maxPlayers - Game.minPlayers + 1
    Game.minPlayers + Int.fromFloat(Math.floor(Math.random() *. Float.fromInt(range)))
  }

  switch (maybeMax, maybeBaseAmount) {
  | (None, None) =>
    Some({maxNumber: ?Some(randomMax), baseAmount: ?Some(Game.minGuessAmount)})
  | (Some(maxNumber), None) =>
    Some({maxNumber: ?Some(maxNumber), baseAmount: ?Some(Game.minGuessAmount)})
  | (None, Some(baseAmount)) =>
    Some({maxNumber: ?Some(randomMax), baseAmount: ?Some(baseAmount)})
  | (Some(maxNumber), Some(baseAmount)) =>
    Some({maxNumber: ?Some(maxNumber), baseAmount: ?Some(baseAmount)})
  }
}

// Clean a sendtag - ensures it matches the database constraint:
// ^[A-Za-z0-9_]+$ with length between 1-20 characters
let cleanSendtag = tag =>
  switch tag->String.replaceRegExp(RegExp.fromString("[^A-Za-z0-9_]", ~flags="g"), "") {
  | "" => None
  | cleaned if cleaned->String.length > 20 => None
  | cleaned => Some(cleaned)
  }

let parseSendNote = args => {
  // Try newline first
  let newlineIndex = args->Array.findIndexOpt(String.includes(_, "\n"))
  let carrotIndex = args->Array.findIndexOpt(String.includes(_, ">"))
  switch (newlineIndex, carrotIndex) {
  | (None, None) => None
  | (Some(newlineIndex), Some(carrotIndex)) =>
    let start = newlineIndex < carrotIndex ? newlineIndex : carrotIndex
    Some(
      args
      ->Array.slice(~start)
      ->Array.reduce("", (acc, note) => acc ++ note),
    )

  | (Some(start), None) =>
    Some(
      args
      ->Array.slice(~start)
      ->Array.reduce("", (acc, note) => acc ++ note),
    )
  | (None, Some(start)) =>
    Some(
      args
      ->Array.slice(~start)
      ->Array.reduce("", (acc, note) => {
        acc ++ note
      }),
    )
  }
}

// Parse send command arguments - simplified to always use SEND token
let parseSendCommand = (args, ~reply: option<Message.t>=?) => {
  let maybeNote = parseSendNote(args)

  // Extract recipient and amount based on whether this is a reply or direct command
  let (maybeRecipient, maybeAmount) = switch reply {
  | Some(replyMsg) =>
    // In reply case, first arg could be amount, recipient comes from reply message
    let maybeAmount = switch args[0]->Option.map(
      String.replaceRegExp(_, RegExp.fromString(",", ~flags="g"), ""),
    ) {
    | Some(amount) if amount->String.match(RegExp.fromString("^\\d+(\.\\d+)?$"))->Option.isSome =>
      Some(amount)
    | _ => None
    }

    let maybeRecipient = switch replyMsg
    ->Message.from
    ->Option.map(User.first_name) {
    | None => None
    | Some(firstName) => {
        let parts = firstName->String.split("/")

        // Check if there are parts after the first slash
        if parts->Array.length > 1 {
          // Take the second part (after the first slash) and clean it
          let rawSendtag = parts[1]->Option.getOr("")
          // Remove emojis and other non-alphanumeric characters except underscores
          let cleanedTag =
            rawSendtag
            ->String.split(" ")
            ->Array.get(0)
            ->Option.getOr("")
            ->String.replaceRegExp(RegExp.fromString("[^A-Za-z0-9_]", ~flags="g"), "")
            ->String.trim
          cleanSendtag(cleanedTag)
        } else {
          None
        }
      }
    }
    (maybeRecipient, maybeAmount)
  | None =>
    // In direct case, first arg should be recipient, second arg could be amount
    let maybeRecipient = args[0]->Option.flatMap(cleanSendtag)

    // Validate amount if present
    let maybeAmount = switch args[1]->Option.map(
      String.replaceRegExp(_, RegExp.fromString(",", ~flags="g"), ""),
    ) {
    | Some(amount) if amount->String.match(RegExp.fromString("^\\d+(\.\\d+)?$"))->Option.isSome =>
      Some(amount)
    | _ => None
    }

    (maybeRecipient, maybeAmount)
  }

  // Return the parsed command if recipient is available
  switch maybeRecipient {
  | None => None
  | Some(recipient) if recipient == "" => None
  | Some(recipient) =>
    Some({
      recipient,
      amount: ?maybeAmount,
      note: ?maybeNote,
    })
  }
}

// Main function to parse command from context
let fromContext = (ctx: Context.t): result<t, error> => {
  // Get message from context
  switch ctx.message->Option.flatMap(Message.text) {
  | None => Error("No text found in message")
  | Some(text) if text->String.length == 0 || text->String.charAt(0) != "/" =>
    Error("Not a command")
  | Some(text) => {
      let command = text->String.split(" ")->Array.get(0)->Option.map(String.toLowerCase)
      let args = text->String.split(" ")->Array.slice(~start=1)
      // Parse different commands
      switch command {
      | Some("/guess") =>
        let maybeOptions = parseGuessCommand(args)
        switch maybeOptions {
        | Some(options) => Ok(Guess(options))
        | None => Error("Invalid guess command parameters")
        }
      | Some("/send") =>
        let maybeOptions = parseSendCommand(
          args,
          ~reply=?ctx.message->Option.flatMap(Message.replyToMessage(_)),
        )
        switch maybeOptions {
        | Some(options) => Ok(Send(options))
        | None => Error("Invalid send command parameters. Missing recipient or invalid amount.")
        }
      | Some("/kill") => Ok(Kill)
      | Some("/help") => Ok(Help)
      | Some(unknownCmd) => Error(`Unknown command: ${unknownCmd}`)
      | None => Error("Invalid command format")
      }
    }
  }
}

// Format error message for user display
let formatErrorMessage = (error: error): string => {
  if error->String.includes("Missing recipient") {
    "Usage: /send <recipient> [amount] [note]"
  } else if error->String.includes("admin") {
    "This command requires admin privileges"
  } else if error->String.includes("Not a command") {
    "Invalid command format"
  } else {
    `Command error: ${error}`
  }
}
