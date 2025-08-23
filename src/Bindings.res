module DotEnv = {
  type t

  @module("dotenv") external config: unit => unit = "config"
}

module Telegraf = {
  type t
  // Phantom tags for distinct Telegram ID kinds
  type messageIdTag
  type chatIdTag
  type userIdTag
  type callbackQueryIdTag

  // Generic abstract ID modules following the article's pattern
  module IntId: {
    type t<'a>
    let toInt: t<_> => int
    let unsafeOfInt: int => t<'a>
  } = {
    type t<'a> = int
    let toInt = v => v
    let unsafeOfInt = v => v
  }

  module StrId: {
    type t<'a>
    let toString: t<_> => string
    let unsafeOfString: string => t<'a>
  } = {
    type t<'a> = string
    let toString = v => v
    let unsafeOfString = v => v
  }

  // Branded Telegram ID types
  type messageId = IntId.t<messageIdTag>
  type chatId = IntId.t<chatIdTag>
  type userId = IntId.t<userIdTag>
  type callbackQueryId = StrId.t<callbackQueryIdTag>

  // Inline keyboard button type
  module InlineKeyboardButton = {
    type t = {
      text: string,
      @as("callback_data") callbackData: option<string>,
      url: option<string>,
    }
  }

  // Reply markup type
  module ReplyMarkup = {
    type t = {@as("inline_keyboard") inlineKeyboard: array<array<InlineKeyboardButton.t>>}
  }

  // Message options type
  module MessageOptions = {
    type t = {
      @as("reply_markup") replyMarkup: ReplyMarkup.t,
      @as("parse_mode") parseMode: option<string>,
    }
  }

  // Options for answerCallbackQuery
  module AnswerCallbackQueryOptions = {
    type t = {
      @as("show_alert") showAlert: option<bool>,
      url: option<string>,
      @as("cache_time") cacheTime: option<int>,
    }
  }

  // No public constructors; bridge from JS via externals and use IntId/StrId helpers when necessary

  // Forward declarations
  module rec User: {
    type t
    @get external id: t => userId = "id"
    @get external first_name: t => string = "first_name"
    @get external username: t => option<string> = "username"
  } = {
    type t
    @get external id: t => userId = "id"
    @get external first_name: t => string = "first_name"
    @get external username: t => option<string> = "username"
  }
  and Admin: {
    type t
    @get external user: t => User.t = "user"
  } = {
    type t
    @get external user: t => User.t = "user"
  }
  and Message: {
    type t
    @get external from: t => option<User.t> = "from"
    @get external text: t => option<string> = "text"
    @get external messageId: t => option<messageId> = "message_id"
    @get external replyToMessage: t => option<Message.t> = "reply_to_message"
  } = {
    type t
    @get external from: t => option<User.t> = "from"
    @get external text: t => option<string> = "text"
    @get external messageId: t => option<messageId> = "message_id"
    @get external replyToMessage: t => option<t> = "reply_to_message"
  }
  and Telegram: {
    type t
    @send
    external getChatAdministrators: (t, chatId) => promise<array<Admin.t>> = "getChatAdministrators"
    @send
    external deleteMessage: (t, chatId, messageId) => promise<bool> = "deleteMessage"
    @send
    external deleteMessages: (t, chatId, array<messageId>) => promise<bool> = "deleteMessages"
    let editMessageTextL: (
      t,
      ~chatId: chatId,
      ~messageId: messageId,
      ~text: string,
      ~options: MessageOptions.t=?,
    ) => promise<Message.t>
    @send
    external editMessageText: (
      t,
      chatId,
      messageId,
      option<string>,
      string,
      ~options: MessageOptions.t=?,
    ) => promise<Message.t> = "editMessageText"
    @send
    external sendMessage: (t, chatId, string, ~options: MessageOptions.t=?) => promise<Message.t> =
      "sendMessage"
    @send
    external answerCbQuery: (
      t,
      callbackQueryId,
      option<string>,
      option<AnswerCallbackQueryOptions.t>,
    ) => promise<bool> = "answerCbQuery"
  } = {
    type t
    @send
    external getChatAdministrators: (t, chatId) => promise<array<Admin.t>> = "getChatAdministrators"
    @send
    external deleteMessage: (t, chatId, messageId) => promise<bool> = "deleteMessage"
    @send
    external deleteMessages: (t, chatId, array<messageId>) => promise<bool> = "deleteMessages"
    @send
    external editMessageText: (
      t,
      chatId,
      messageId,
      option<string>,
      string,
      ~options: MessageOptions.t=?,
    ) => promise<Message.t> = "editMessageText"
    let editMessageTextL = (t, ~chatId, ~messageId, ~text, ~options=?) =>
      editMessageText(t, chatId, messageId, None, text, ~options?)
    @send
    external sendMessage: (t, chatId, string, ~options: MessageOptions.t=?) => promise<Message.t> =
      "sendMessage"
    @send
    external answerCbQuery: (
      t,
      callbackQueryId,
      option<string>,
      option<AnswerCallbackQueryOptions.t>,
    ) => promise<bool> = "answerCbQuery"
  }

  module Chat = {
    type t = {
      id: chatId,
      @as("type") type_: string,
    }
    @get external id: t => chatId = "id"
  }

  module Bot = {
    type t
    module Info = {
      type t = {
        id: chatId,
        @as("type") type_: string,
      }
      @get external id: t => chatId = "id"
    }
    @get external info: t => option<Info.t> = "botInfo"
  }

  // Define CallbackQuery module before Context uses it
  module CallbackQuery = {
    type t
    @get external id: t => callbackQueryId = "id"
    @get external data: t => option<string> = "data"
  }

  module Context = {
    type t = {
      chat: option<Chat.t>,
      message: option<Message.t>,
      from: option<User.t>,
      callbackQuery: option<CallbackQuery.t>,
      telegram: Telegram.t,
      bot: option<Bot.t>,
    }
    @get external telegram: t => Telegram.t = "telegram"
    @get external message: t => option<Message.t> = "message"
    @get external chat: t => option<Chat.t> = "chat"
    @get external from: t => option<User.t> = "from"
    @get external callbackQuery: t => option<CallbackQuery.t> = "callbackQuery"
    @get external bot: t => option<Bot.t> = "bot"
    @send external reply: (t, string, ~options: MessageOptions.t=?) => promise<Message.t> = "reply"
    @send
    external answerCbQuery: (
      t,
      option<string>,
      option<AnswerCallbackQueryOptions.t>,
    ) => promise<bool> = "answerCbQuery"
  }

  // Launch options types
  module LaunchOptions = {
    module Webhook = {
      type t = {
        domain: string,
        port: option<int>,
      }
    }

    type t = {webhook: option<Webhook.t>}
  }

  // Main module exports
  @module("telegraf") @new external make: string => t = "Telegraf"
  @get external telegram: t => Telegram.t = "telegram"
  @send external command: (t, string, Context.t => promise<unit>) => t = "command"
  @send external action: (t, string, Context.t => promise<unit>) => t = "action"
  @send external launch: t => promise<unit> = "launch"
  @send external launchWithOptions: (t, LaunchOptions.t) => promise<unit> = "launch"
  @send external stop: t => promise<unit> = "stop"
}
