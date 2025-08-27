open Bindings
open Telegraf
open MessageFormat

@val external encodeURIComponent: string => string = "encodeURIComponent"

module Process = {
  @scope("process") @val external env: Dict.t<string> = "env"
  @val external on: (string, unit => unit) => unit = "process.on"
  let onSIGINT = (callback: unit => unit) => on("SIGINT", callback)
}

DotEnv.config()

@scope(("process", "env")) @val
external botToken: option<string> = "BOT_TOKEN"

let defaultTelegramOptions = MessageFormat.toTelegramOptions(MessageFormat.defaultOptions)

let telegraf = switch botToken {
| Some(token) => make(token)
| None => failwith("BOT_TOKEN is required")
}

// State stores
let games: Map.t<Telegraf.chatId, Game.state> = Map.make()
let surges: Map.t<Telegraf.chatId, Game.surge> = Map.make()
let pendingJoins: Map.t<Telegraf.chatId, Game.pendingJoin> = Map.make()

let sleep = ms =>
  Promise.make((resolve, _) => {
    Js.Global.setTimeout(() => resolve()->ignore, ms)->ignore
  })

let rec withRetry = async (fn, ~maxRetries=3, ~initialDelay=1000, ~attempt=0) => {
  if attempt >= maxRetries {
    Error("Max retries exceeded")
  } else {
    if attempt > 0 {
      await sleep(initialDelay * 2 ** (attempt - 1))
    }
    try {Ok(await fn())} catch {
    | _ => await withRetry(fn, ~maxRetries, ~initialDelay, ~attempt=attempt + 1)
    }
  }
}

// Helpers to generate MarkdownV2 text for /send using typed Markdown builder
let repeat = (ch: string, count: int) => {
  let rec aux = (i, acc) =>
    if i <= 0 {
      acc
    } else {
      aux(i - 1, acc ++ ch)
    }
  aux(count, "")
}

let buildSendMd = (
  ctx: Telegraf.Context.t,
  recipient: Sendtag.t,
  amountOpt: option<Amount.verified>,
  noteOpt: option<string>,
): Markdown.t => {
  // Sender name and recipient
  let senderName = ctx.from->Option.mapOr("", u => u->Telegraf.User.first_name)
  let mdSender = Markdown.text(senderName)
  let mdRecipient = Markdown.text(Sendtag.toDisplay(recipient))
  // Determine header content
  let headerCore = switch amountOpt {
  | Some(a) => {
      let amtMd = Amount.displayToMd(a.display)
      Markdown.bold(
        Markdown.concat([amtMd, Markdown.text(" " ++ Command.send.symbol ++ " to "), mdRecipient]),
      )
    }
  | None => Markdown.bold(Markdown.concat([mdSender, Markdown.text(" sending to "), mdRecipient]))
  }
  // Header line with plain-text gutter to avoid color mismatch
  let headerMd = Markdown.concat([Markdown.text("\n┃ "), headerCore])
  // Optional note rendered with divider and plain-text gutter (prefix every line)
  let noteMd = switch noteOpt {
  | None => Markdown.text("")
  | Some(n) => {
      let parts = n->String.split("\n")
      let prefixed = parts->Array.reduce("", (acc, line) =>
        if acc == "" {
          "┃ " ++ line
        } else {
          acc ++ "\n┃ " ++ line
        }
      )
      Markdown.concat([
        Markdown.text("\n┃ ━━━━━━━━━━\n"),
        Markdown.text(prefixed),
      ])
    }
  }
  // Optional reply mention (if replying to a user)
  let replyMd = switch ctx.message
  ->Option.flatMap(Message.replyToMessage(_))
  ->Option.flatMap(m => m->Message.from) {
  | Some(u) => Markdown.mentionUserId(u->Telegraf.User.id->Telegraf.IntId.toInt)
  | None => Markdown.text("")
  }
  // Compute sender padding only when amount shown
  let senderPadMd = switch amountOpt {
  | Some(_a) => {
      let senderEscaped = MessageFormat.escapeMarkdown(senderName)
      let padLen = 28 - String.length(senderEscaped) - 8
      let effectivePad = if padLen > 0 {
        padLen
      } else {
        0
      }
      Markdown.senderLine(~padding=effectivePad, ~senderName=mdSender)
    }
  | None => Markdown.text("")
  }
  Markdown.concat([headerMd, noteMd, senderPadMd, replyMd])
}

// Delete queue
type deleteTask = {chatId: Telegraf.chatId, messageId: Telegraf.messageId}
let deleteQueue: array<deleteTask> = []
let isProcessingDeleteQueue = ref(false)

let drainDeleteQueue = async () => {
  if !isProcessingDeleteQueue.contents {
    isProcessingDeleteQueue.contents = true
    Console.log("[deleteQueue] start draining")
    // Process items one by one to keep it simple and safe
    while deleteQueue->Array.length > 0 {
      switch deleteQueue->Js.Array2.pop {
      | Some(task) => {
          Console.log(
            `[/delete] deleting chatId=${task.chatId
              ->Telegraf.IntId.toInt
              ->Int.toString}, messageId=${task.messageId->Telegraf.IntId.toInt->Int.toString}`,
          )
          let _ = await telegraf
          ->telegram
          ->Telegram.deleteMessage(task.chatId, task.messageId)
          ->Promise.catch(_e => {
            Console.warn("[/delete] deleteMessage failed, ignoring")
            Promise.resolve(false)
          })
          await sleep(100)
        }
      | None => ()
      }
    }
    isProcessingDeleteQueue.contents = false
    Console.log("[deleteQueue] done draining")
  } else {
    ()
  }
}

// One-shot scheduling for delete queue (pattern modeled after processPendingJoins)
let deleteQueueTimeout = ref(None)
let scheduleDeleteQueueDrain = () => {
  switch deleteQueueTimeout.contents {
  | Some(_) => ()
  | None => deleteQueueTimeout.contents = Some(Js.Global.setTimeout(() => {
        // reset the timer ref and trigger drain
        deleteQueueTimeout.contents = None
        drainDeleteQueue()->ignore
      }, 1000))
  }
}
let enqueueDelete = (task: deleteTask) => {
  deleteQueue->Array.push(task)
  if !isProcessingDeleteQueue.contents {
    scheduleDeleteQueueDrain()
  } else {
    ()
  }
}

// Helper: extract/clean sendtag from user name (mirror handleJoinGame 401–409)
let extractCleanSendtagFromUser = (user: Telegraf.User.t): option<string> => {
  let nameParts = user->Telegraf.User.first_name->String.split("/")
  let rawSendtag = nameParts->Array.get(1)->Option.getOr("")
  let cleanSendtag =
    rawSendtag
    ->String.replaceRegExp(RegExp.fromString("[^a-zA-Z0-9_]", ~flags="gu"), "")
    ->String.trim
  if cleanSendtag == "" {
    None
  } else {
    Some(cleanSendtag)
  }
}

module AdminUtils = {
  type adminCacheValue = {ids: array<Telegraf.userId>, timestamp: float}
  type adminCache = Map.t<Telegraf.chatId, adminCacheValue>
  let adminCache = Map.make()
  let cacheTimeout = 60. *. 60. *. 1000.
  let getAdminIds = async (ctx, chatId) => {
    let now = Date.now()
    let isExpired = (cached, cacheTimeout) => Date.now() -. cached.timestamp > cacheTimeout
    switch adminCache->Map.get(chatId) {
    | Some(cached) if !isExpired(cached, cacheTimeout) => cached.ids
    | _ => {
        let admins = await ctx->Context.telegram->Telegram.getChatAdministrators(chatId)
        let adminIds = admins->Array.map(a => a->Telegraf.Admin.user->Telegraf.User.id)
        adminCache->Map.set(chatId, {ids: adminIds, timestamp: now})
        adminIds
      }
    }
  }
}

let handleGuessCommand = async (ctx: Telegraf.Context.t) => {
  let chatId = ctx.chat->Option.mapOr(Telegraf.IntId.unsafeOfInt(0), c => c.id)
  // Global sendtag enforcement (mirror handleJoinGame 401–409 and /send private reply 535–543)
  let hasSendtag = switch ctx.from {
  | Some(u) => extractCleanSendtagFromUser(u)->Option.isSome
  | None => false
  }
  if !hasSendtag {
    let isPrivate = ctx.chat->Option.mapOr(false, c => c.id->Telegraf.IntId.toInt > 0)
    if isPrivate {
      let _ = await ctx->Context.reply("Add sendtag to your name!", ~options=defaultTelegramOptions)
    } else {
      ()
    }
    // Queue deletion of original command (mirror 212–215 and 280–283)
    switch ctx.message->Option.flatMap(Message.messageId) {
    | Some(msgId) => enqueueDelete({chatId, messageId: msgId})
    | None => ()
    }
    Ok()
  } else {
    let state = games->Map.get(chatId)
    let _surge = surges->Map.get(chatId)->Option.getOr({Game.multiplier: 0, updatedAt: 0.})
    switch state {
    | Some(Game.Collecting(_) as s) => {
        let messageText = Game.gameStateText(s)
        // Use MarkdownV2 options (mirror winner opts 371–379)
        let options = {
          ...MessageFormat.defaultOptions,
          format: #Markdown,
          replyMarkup: Some(
            MessageFormat.inlineKeyboard([
              [MessageFormat.callbackButton(~text="/join", ~data="join_game")],
            ]),
          ),
        }
        let opts: Telegraf.MessageOptions.t = MessageFormat.toTelegramOptions(options)
        let messageId = switch s {
        | Game.Collecting(c) => c.messageId
        | _ => Telegraf.IntId.unsafeOfInt(0)
        }
        Console.log(`[/edit guess] prefix: ${messageText->String.slice(~start=0, ~end=120)}`)
        let _ = await withRetry(() =>
          ctx
          ->Context.telegram
          ->Telegram.editMessageTextL(~chatId, ~messageId, ~text=messageText, ~options=opts)
        )
        switch ctx.message->Option.flatMap(Message.messageId) {
        | Some(msgId) => enqueueDelete({chatId, messageId: msgId})
        | None => ()
        }
        Ok()
      }
    | _ => {
        // Parse /guess options like we do for /send using Command.fromContext
        let parsed = Command.fromContext(ctx)
        let (chatId, newState) = switch (parsed, ctx.message, ctx.from) {
        | (Ok(Command.Guess({?maxNumber, ?baseAmount})), Some(_m), Some(from)) => {
            // Compute current minimum including surge
            let prevSurge = surges->Map.get(chatId)
            let surgeAmount = switch prevSurge {
            | Some(s) if Game.isSurgeActive(s) => BigInt.fromInt(s.multiplier) * Game.surgeIncrease
            | _ => 0n
            }
            let currentMin = Game.minGuessAmount + surgeAmount

            // Decide final base amount and whether to apply surge
            let applySurge = switch baseAmount {
            | Some(requested) => requested < currentMin
            | None => true
            }
            let finalBase = switch baseAmount {
            | Some(requested) if requested >= currentMin => requested
            | _ => Game.minGuessAmount
            }
            // Pass the previous surge state to this game (so first guess after cooldown is not boosted)
            let finalSurge = if applySurge {
              prevSurge
            } else {
              None
            }

            let maxPlayers = switch maxNumber {
            | Some(n) => n
            | None => {
                let range = Game.maxPlayers - Game.minPlayers + 1
                Game.minPlayers + Int.fromFloat(Math.floor(Math.random() *. Float.fromInt(range)))
              }
            }

            let result = Game.createGame(
              chatId,
              from,
              ~maxPlayers,
              ~baseAmount=finalBase,
              ~surge=?finalSurge,
            )

            // After creating the game, update surge state for future guesses (increment or reset)
            if applySurge {
              switch prevSurge {
              | Some(s) if Game.isSurgeActive(s) =>
                surges->Map.set(chatId, {Game.multiplier: s.multiplier + 1, updatedAt: Date.now()})
              | _ => surges->Map.set(chatId, {Game.multiplier: 1, updatedAt: Date.now()})
              }
            } else {
              ()
            }
            result
          }
        | (_, Some(_m), None) => (chatId, Game.Cancelled(Game.Error("Missing user information")))
        | _ => (chatId, Game.Cancelled(Game.Error("Missing message information")))
        }
        games->Map.set(chatId, newState)
        switch newState {
        | Game.Collecting(_) => {
            let messageText = Game.gameStateText(newState)
            let options = {
              ...MessageFormat.defaultOptions,
              format: #Markdown,
              replyMarkup: Some(
                MessageFormat.inlineKeyboard([
                  [MessageFormat.callbackButton(~text="/join", ~data="join_game")],
                ]),
              ),
            }
            let opts: Telegraf.MessageOptions.t = MessageFormat.toTelegramOptions(options)
            switch await withRetry(() => ctx->Context.reply(messageText, ~options=opts)) {
            | Ok(message) => {
                switch message->Message.messageId {
                | Some(msgId) =>
                  games->Map.set(
                    chatId,
                    switch newState {
                    | Game.Collecting(c) => Game.Collecting({...c, messageId: msgId})
                    | other => other
                    },
                  )
                | None => ()
                }
                switch ctx.message->Option.flatMap(Message.messageId) {
                | Some(msgId) => enqueueDelete({chatId, messageId: msgId})
                | None => ()
                }
                Ok()
              }
            | Error(e) => Error(`Failed to send game message: ${e}`)
            }
          }
        | _ => Error("Failed to create game")
        }
      }
    }
  }
}

let processPendingJoins = async chatId => {
  let pendingJoin = pendingJoins->Map.get(chatId)
  let gameState = games->Map.get(chatId)
  switch (pendingJoin, gameState) {
  | (Some({players}), Some(Game.Collecting(c) as state)) => {
      let _ = pendingJoins->Map.delete(chatId)
      let prevMessageId = c.messageId
      let uniquePlayers: array<Game.player> = players->Array.reduce([], (
        acc: array<Game.player>,
        player: Game.player,
      ) =>
        if acc->Array.some((p: Game.player) => p.userId === player.userId) {
          acc
        } else {
          acc->Array.concat([player])
        }
      )
      let positions: array<(Game.player, int)> = []
      let finalState = uniquePlayers->Array.reduce(state, (currentState, player: Game.player) => {
        let (ns, pos) = Game.addPlayer(currentState, player)
        positions->Array.push((player, pos))
        ns
      })
      games->Map.set(chatId, finalState)
      let _ = await Promise.all(
        positions->Array.map(((player: Game.player, position: int)) => {
          let message = if position > 0 {
            switch finalState {
            | Game.Completed(c) =>
              if c.winner.userId == player.userId {
                "🎉 You won! 🎉"
              } else {
                `You're #${position->Int.toString} 🎲`
              }
            | _ => `You're #${position->Int.toString} 🎲`
            }
          } else {
            "Game filled up! 😢"
          }
          Telegraf.telegram(telegraf)->Telegram.answerCbQuery(
            player.callbackQueryId,
            Some(message),
            None,
          )
        }),
      )
      switch finalState {
      | Game.Collecting(c) => {
          let messageText = Game.gameStateText(finalState)
          Console.log(`[/edit collect] prefix: ${messageText->String.slice(~start=0, ~end=120)}`)
          let options = {
            ...MessageFormat.defaultOptions,
            format: #Markdown,
            replyMarkup: Some(
              MessageFormat.inlineKeyboard([
                [MessageFormat.callbackButton(~text="/join", ~data="join_game")],
              ]),
            ),
          }
          let telegramOptions: Telegraf.MessageOptions.t = MessageFormat.toTelegramOptions(options)
          let _ = await withRetry(() =>
            Telegraf.telegram(telegraf)->Telegram.editMessageTextL(
              ~chatId,
              ~messageId=c.messageId,
              ~text=messageText,
              ~options=telegramOptions,
            )
          )
          Ok()
        }
      | Game.Completed(c) => {
          // Delete the old collecting message so the /join button disappears (parity with TS)
          enqueueDelete({chatId, messageId: prevMessageId})
          let winnerMessage = Game.formatWinnerMessage(finalState)
          let sendtagStr = c.winner.sendtag->String.replace("/", "")
          let replyMarkupOpt = switch Sendtag.parse(sendtagStr) {
          | Some(recipient) => {
              let amountVerified: Amount.verified = {
                units: c.amount,
                display: Amount.formatUnits(c.amount),
              }
              let command: Command.sendOptions = {recipient, amount: ?Some(amountVerified)}
              let url = Command.generateSendUrl(command)
              Some(MessageFormat.inlineKeyboard([[MessageFormat.button(~text="/send", ~url)]]))
            }
          | None => None
          }
          let options = {
            ...MessageFormat.defaultOptions,
            format: #Markdown,
            replyMarkup: replyMarkupOpt,
          }
          let telegramOptions = MessageFormat.toTelegramOptions(options)
          let _ = await withRetry(() =>
            Telegraf.telegram(telegraf)->Telegram.sendMessage(
              chatId,
              `${Game.gameStateText(finalState)}\n\n${winnerMessage}`,
              ~options=telegramOptions,
            )
          )
          Ok()
        }
      | _ => Ok()
      }
    }
  | _ => Ok()
  }
}

let handleJoinGame = async (ctx: Telegraf.Context.t, query: Telegraf.CallbackQuery.t) => {
  let chatId = ctx.chat->Option.mapOr(Telegraf.IntId.unsafeOfInt(0), c => c.id)
  let game = games->Map.get(chatId)
  let joinResult: Game.joinResult = switch (game, ctx.from) {
  | (Some(Game.Collecting(_) as state), Some(user)) => {
      let nameParts = user->Telegraf.User.first_name->String.split("/")
      let rawSendtag = nameParts->Array.get(1)->Option.getOr("")
      let cleanSendtag =
        rawSendtag
        ->String.replaceRegExp(RegExp.fromString("[^a-zA-Z0-9_]", ~flags="gu"), "")
        ->String.trim
      if cleanSendtag == "" {
        Game.Error(Game.NoSendTag)
      } else {
        let isAlreadyPending =
          pendingJoins
          ->Map.get(chatId)
          ->Option.flatMap(({players}) =>
            players->Array.find(p => p.userId == user->Telegraf.User.id)
          )
          ->Option.isSome
        let isAlreadyInGame = switch state {
        | Game.Collecting(c) => c.players->Array.some(p => p.userId == user->Telegraf.User.id)
        | _ => false
        }
        if isAlreadyInGame || isAlreadyPending {
          Game.Error(Game.AlreadyJoined)
        } else {
          let player: Game.player = {
            sendtag: `/${cleanSendtag}`,
            userId: user->Telegraf.User.id,
            callbackQueryId: query->Telegraf.CallbackQuery.id,
          }
          let pendingJoin =
            pendingJoins->Map.get(chatId)->Option.getOr({players: [], timeout: None})
          let updatedPlayers = pendingJoin.players->Array.concat([player])
          let timeout = switch pendingJoin.timeout {
          | Some(t) => Some(t)
          | None => Some(Js.Global.setTimeout(() => {processPendingJoins(chatId)->ignore}, 1000))
          }
          pendingJoins->Map.set(chatId, {players: updatedPlayers, timeout})
          Game.Success(updatedPlayers->Array.length)
        }
      }
    }
  | (None, _) => Game.Error(Game.NoActiveGame)
  | _ => Game.Error(Game.GameFull)
  }
  let responseMessage = switch joinResult {
  | Game.Success(position) => `Processing...  🎲 (${position->Int.toString})`
  | Game.Error(Game.NoActiveGame) => "No active game!"
  | Game.Error(Game.NoSendTag) => "Add sendtag to your name!"
  | Game.Error(Game.AlreadyJoined) => "Already joined!"
  | Game.Error(Game.GameFull) => "Game is already full!"
  | Game.Error(Game.InternalError(msg)) => `Error: ${msg}`
  }
  await ctx->Telegraf.Context.answerCbQuery(Some(responseMessage), None)
}

let setupBot = () => {
  telegraf
  ->Telegraf.command("guess", async ctx => {
    let rawText = ctx.message->Option.flatMap(Message.text)->Option.getOr("")
    Console.log(`[/guess] raw: ${rawText}`)
    let _ = await handleGuessCommand(ctx)
  })
  ->ignore
  telegraf
  ->Telegraf.command("send", async ctx => {
    // Global sendtag enforcement (mirror handleJoinGame 401–409)
    let cleanedTagOpt = ctx.from->Option.flatMap(extractCleanSendtagFromUser)
    let hasSendtag = cleanedTagOpt->Option.isSome
    let hasSendtag = hasSendtag
    if !hasSendtag {
      let isPrivate = ctx.chat->Option.mapOr(false, c => c.id->Telegraf.IntId.toInt > 0)
      if isPrivate {
        let _ = await ctx->Context.reply(
          "Add sendtag to your name!",
          ~options=defaultTelegramOptions,
        )
      } else {
        ()
      }
      // Always queue deletion of original command
      let chatId2 = ctx.chat->Option.mapOr(Telegraf.IntId.unsafeOfInt(0), c => c.id)
      switch ctx.message->Option.flatMap(Message.messageId) {
      | Some(msgId) => enqueueDelete({chatId: chatId2, messageId: msgId})
      | None => ()
      }
    } else {
      switch Command.fromContext(ctx) {
      | Ok(Command.Send({recipient, ?amount, ?note})) => {
          let command: Command.sendOptions = {recipient, ?amount, ?note}
          let url = Command.generateSendUrl(command)
          // Build Markdown message using typed builder
          let md = buildSendMd(ctx, recipient, amount, note)
          let messageTextBase = Markdown.render(md)
          // Hidden profile link to trigger OG preview
          let profileUrl = `${Command.baseUrl}${recipient->Sendtag.toParam}`
          let hiddenLink = "[‎](" ++ profileUrl ++ ")"
          let messageText = messageTextBase ++ "\n\n" ++ hiddenLink
          // Always include inline '/send' button linking to generated URL
          let replyMarkup = MessageFormat.inlineKeyboard([
            [MessageFormat.button(~text="/send", ~url)],
          ])
          let options = {
            ...MessageFormat.defaultOptions,
            format: #Markdown,
            replyMarkup: Some(replyMarkup),
          }
          let telegramOptions = MessageFormat.toTelegramOptions(options)
          switch await withRetry(() => ctx->Context.reply(messageText, ~options=telegramOptions)) {
          | Ok(_) => ()
          | Error(e) => Console.error2("[/send] failed to reply:", e)
          }
          let chatId2 = ctx.chat->Option.mapOr(Telegraf.IntId.unsafeOfInt(0), c => c.id)
          switch ctx.message->Option.flatMap(Message.messageId) {
          | Some(msgId) => enqueueDelete({chatId: chatId2, messageId: msgId})
          | None => ()
          }
        }
      | Ok(other) => {
          Console.warn(
            `[/send] unexpected command variant: ${switch other {
              | Command.Guess(_) => "Guess"
              | Command.Kill => "Kill"
              | Command.Help => "Help"
              | _ => "Other"
              }}`,
          )
          // Always queue deletion of original command
          let chatId2 = ctx.chat->Option.mapOr(Telegraf.IntId.unsafeOfInt(0), c => c.id)
          switch ctx.message->Option.flatMap(Message.messageId) {
          | Some(msgId) => enqueueDelete({chatId: chatId2, messageId: msgId})
          | None => ()
          }
        }
      | Error(msg) => {
          Console.error(`[/send] parse error: ${msg}`)
          // Reply with error in private chats only to avoid spam; still delete original
          let isPrivate = ctx.chat->Option.mapOr(false, c => c.id->Telegraf.IntId.toInt > 0)
          if isPrivate {
            let _ = await ctx->Context.reply(
              `Command error: ${msg}`,
              ~options=defaultTelegramOptions,
            )
          } else {
            ()
          }
          // Always queue deletion of original command
          let chatId2 = ctx.chat->Option.mapOr(Telegraf.IntId.unsafeOfInt(0), c => c.id)
          switch ctx.message->Option.flatMap(Message.messageId) {
          | Some(msgId) => enqueueDelete({chatId: chatId2, messageId: msgId})
          | None => ()
          }
        }
      }
    }
  })
  ->ignore
  telegraf
  ->Telegraf.command("kill", async ctx => {
    let rawText = ctx.message->Option.flatMap(Message.text)->Option.getOr("")
    Console.log(`[/kill] raw: ${rawText}`)
    let chatId = ctx.chat->Option.mapOr(Telegraf.IntId.unsafeOfInt(0), c => c.id)
    // Global sendtag enforcement pre-check
    let hasSendtag = switch ctx.from {
    | Some(u) => extractCleanSendtagFromUser(u)->Option.isSome
    | None => false
    }
    if !hasSendtag {
      let isPrivate = ctx.chat->Option.mapOr(false, c => c.id->Telegraf.IntId.toInt > 0)
      if isPrivate {
        let _ = await ctx->Context.reply(
          "Add sendtag to your name!",
          ~options=defaultTelegramOptions,
        )
      } else {
        ()
      }
      // Queue deletion of original command for consistency
      switch ctx.message->Option.flatMap(Message.messageId) {
      | Some(msgId) => enqueueDelete({chatId, messageId: msgId})
      | None => ()
      }
    } else {
      let isAdmin = switch ctx.from {
      | Some(from) =>
        (await AdminUtils.getAdminIds(ctx, chatId))->Array.includes(from->Telegraf.User.id)
      | None => false
      }
      if !isAdmin {
        Console.warn("[/kill] non-admin attempted kill")
        let isPrivate = ctx.chat->Option.mapOr(false, c => c.id->Telegraf.IntId.toInt > 0)
        if isPrivate {
          let _ = await ctx->Context.reply(
            "Only admins can kill games",
            ~options=defaultTelegramOptions,
          )
        } else {
          ()
        }
        // Enqueue deletion of original /kill command
        switch ctx.message->Option.flatMap(Message.messageId) {
        | Some(msgId) => enqueueDelete({chatId, messageId: msgId})
        | None => ()
        }
      } else {
        switch games->Map.get(chatId) {
        | Some(Game.Collecting(st)) => {
            // Safely unwrap ctx.from before constructing reason
            let reason = switch ctx.from {
            | Some(u) => Game.AdminCancelled(u)
            | None => Game.MasterCancelled
            }
            let newState = Game.cancelGame(Game.Collecting(st), reason)
            games->Map.set(chatId, newState)
            // Edit existing game message instead of replying to chat
            let messageText = Game.gameStateText(newState)
            Console.log(`[/edit kill] prefix: ${messageText->String.slice(~start=0, ~end=120)}`)
            let _ = await withRetry(() =>
              Telegraf.telegram(telegraf)->Telegram.editMessageTextL(
                ~chatId,
                ~messageId=st.messageId,
                ~text=messageText,
                ~options=defaultTelegramOptions,
              )
            )
            // Enqueue deletion of original /kill command
            switch ctx.message->Option.flatMap(Message.messageId) {
            | Some(msgId) => enqueueDelete({chatId, messageId: msgId})
            | None => ()
            }
          }
        | _ => {
            let isPrivate = ctx.chat->Option.mapOr(false, c => c.id->Telegraf.IntId.toInt > 0)
            if isPrivate {
              let _ = await ctx->Context.reply(
                "No active game to kill",
                ~options=defaultTelegramOptions,
              )
            } else {
              ()
            }
            // Enqueue deletion of original /kill command
            switch ctx.message->Option.flatMap(Message.messageId) {
            | Some(msgId) => enqueueDelete({chatId, messageId: msgId})
            | None => ()
            }
          }
        }
      }
    }
  })
  ->ignore
  telegraf
  ->Telegraf.command("help", async ctx => {
    // Dynamic help text using Game constants
    let baseMin = Game.minGuessAmount
    let inc = Game.surgeIncrease
    let min1 = Game.formatAmount(baseMin)
    let min2 = Game.formatAmount(baseMin + inc)
    let min3 = Game.formatAmount(baseMin + inc + inc)
    let cooldownMin = Int.toString(Game.surgeCooldown / 60000)
    let helpText =
      "\n*SendBot* only works if your sendtag is in your name\n\n" ++
      "*/send*\n" ++
      "Send SEND tokens\n" ++
      "\`/send /vic 30 SEND\`\n\n" ++
      "*Send with note*\n" ++
      "\`/send /vic 30 > Hello!\`\n\n" ++
      "*Send as reply*\n" ++
      "\`/send 30 > Hello!\`\n\n" ++
      "*Games*\n" ++
      "• /guess \\- Random slots, " ++
      min1 ++
      " SEND minimum\n" ++
      "• /guess " ++
      min1 ++
      " \\- Random slots, " ++
      min1 ++
      " SEND prize\n" ++
      "• /guess 10 " ++
      min1 ++
      " \\- 10 slots, " ++
      min1 ++
      " SEND prize\n" ++
      "• /kill \\- End your game\n\n" ++
      "*Send Surge* " ++
      cooldownMin ++
      " minute cooldown\n" ++
      "\`/guess \\- " ++
      min1 ++
      " SEND minimum\n" ++
      "/guess \\- " ++
      min2 ++
      " SEND minimum\n" ++
      "/guess \\- " ++
      min3 ++ " SEND minimum\`"
    let options = {...MessageFormat.defaultOptions, format: #Markdown}
    let _ = await ctx->Context.reply(helpText, ~options=MessageFormat.toTelegramOptions(options))
  })
  ->ignore
  telegraf
  ->Telegraf.command("start", async ctx => {
    let startText = "\n👋 Welcome to the Send Bot!\n\nThis bot allows you to play guessing games with SEND tokens and send tokens to other users.\n\nUse /help to see available commands.\n"
    let isPrivate = ctx.chat->Option.mapOr(false, c => c.id->Telegraf.IntId.toInt > 0)
    if isPrivate {
      let _ = await ctx->Context.reply(startText, ~options=defaultTelegramOptions)
    } else {
      ()
    }
  })
  ->ignore
  telegraf
  ->Telegraf.action("join_game", async ctx => {
    switch ctx.callbackQuery {
    | Some(q) => {
        let _ = await handleJoinGame(ctx, q)
      }
    | None => Console.warn("[/join] no callbackQuery present")
    }
  })
  ->ignore
}

setupBot()
switch Process.env->Dict.get("DOMAIN") {
| Some(domain) => {
    let port = Process.env->Dict.get("PORT")->Option.flatMap(Int.fromString(_))->Option.getOr(3000)
    let options: Telegraf.LaunchOptions.t = {webhook: Some({domain, port: Some(port)})}
    telegraf->Telegraf.launchWithOptions(options)->ignore
  }
| None => telegraf->Telegraf.launch->ignore
}
Process.onSIGINT(() => {
  Console.log("Bot is shutting down")
  let _ = telegraf->stop
})
