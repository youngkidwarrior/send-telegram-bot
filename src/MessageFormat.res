// Message format types using polymorphic variants
type format = [#Regular | #Markdown | #HTML]

// Button action types using polymorphic variants
type buttonAction = [
  | #Callback(string)
  | #Url(string)
  | #SwitchInlineQuery(string)
  | #SwitchInlineQueryCurrentChat(string)
]

// Type for inline keyboard buttons
type rec button = {
  text: string,
  action: buttonAction,
}

// Type for reply markup
and markup =
  | InlineKeyboard(array<array<button>>)
  | ReplyKeyboard({
      buttons: array<array<string>>,
      resize: bool,
      oneTime: bool,
      placeholder: option<string>,
    })
  | RemoveKeyboard
  | ForceReply({placeholder: option<string>, selective: bool})

// Type for message options
and options = {
  format: format,
  disableWebPagePreview: bool,
  disableNotification: bool,
  replyMarkup: option<markup>,
}

// Create default message options
let defaultOptions = {
  format: #Regular,
  disableWebPagePreview: false,
  disableNotification: false,
  replyMarkup: None,
}

// Helper functions for buttons
let button = (~text, ~url) => {
  text,
  action: #Url(url),
}

let callbackButton = (~text, ~data) => {
  text,
  action: #Callback(data),
}

let switchInlineButton = (~text, ~query, ~currentChat=false) => {
  text,
  action: currentChat ? #SwitchInlineQueryCurrentChat(query) : #SwitchInlineQuery(query),
}

// Helper functions for markup
let inlineKeyboard = buttons => InlineKeyboard(buttons)

let replyKeyboard = (~buttons, ~resize=true, ~oneTime=false, ~placeholder=?) =>
  ReplyKeyboard({
    buttons,
    resize,
    oneTime,
    placeholder,
  })

// Convert options to Telegram API format
let toTelegramOptions = (options): Bindings.Telegraf.MessageOptions.t => {
  // Create parseMode based on format
  let parseMode = switch options.format {
  | #Markdown => Some("MarkdownV2")
  | #HTML => Some("HTML")
  | #Regular => None
  }

  // Convert replyMarkup to Telegraf format
  let replyMarkup = switch options.replyMarkup {
  | Some(InlineKeyboard(buttons)) => {
      // Convert our buttons to Telegraf's InlineKeyboardButton format
      let inlineKeyboard =
        Array.map(buttons, row =>
          Array.map(row, button => {
            // Create a proper InlineKeyboardButton object matching the binding's type
            let buttonObj: Bindings.Telegraf.InlineKeyboardButton.t = switch button.action {
            | #Callback(data) => {
                text: button.text,
                callbackData: Some(data),
                url: None
              }
            | #Url(url) => {
                text: button.text,
                url: Some(url),
                callbackData: None
              }
            | #SwitchInlineQuery(query) => {
                text: button.text,
                callbackData: Some(`switch:${query}`),
                url: None
              }
            | #SwitchInlineQueryCurrentChat(query) => {
                text: button.text,
                callbackData: Some(`switchCurrent:${query}`),
                url: None
              }
            }
            buttonObj
          })
        )

      // Create the ReplyMarkup object with inlineKeyboard
      let markup: Bindings.Telegraf.ReplyMarkup.t = {
        inlineKeyboard: inlineKeyboard
      }
      markup
    }
  | Some(ReplyKeyboard(_)) | Some(RemoveKeyboard) | Some(ForceReply(_)) | None => {
      // For unsupported markup types, create an empty inline keyboard
      let markup: Bindings.Telegraf.ReplyMarkup.t = {
        inlineKeyboard: []
      }
      markup
    }
  }

  // Construct and return the properly typed MessageOptions object
  {
    replyMarkup: replyMarkup,
    parseMode: parseMode
  }
}

// Markdown helpers
let escapeMarkdown = text => {
  // Characters that need escaping in MarkdownV2: _ * [ ] ( ) ~ ` > # + - = | { } . !
  let specialChars = [
    "_",
    "*",
    "[",
    "]",
    "(",
    ")",
    "~",
    "`",
    ">",
    "#",
    "+",
    "-",
    "=",
    "|",
    "{",
    "}",
    ".",
    "!",
  ]

  let textEscaped = Array.reduce(specialChars, text, (acc, char) => {
    let pattern = switch char {
    | "[" | "]" | "(" | ")" | "{" | "}" | "." | "+" | "*" | "|" | "^" | "$" | "?" | "\\" =>
      "\\" ++ char
    | _ => char
    }
    let regex = RegExp.fromString(pattern, ~flags="g")
    acc->String.replaceRegExp(regex, "\\" ++ char)
  })
  textEscaped
}

// Markdown formatting helpers
let bold = text => "*" ++ text->escapeMarkdown ++ "*"
let italic = text => "_" ++ text->escapeMarkdown ++ "_"
let code = text => "`" ++ text->escapeMarkdown ++ "`"
let pre = (text, ~language=?) => {
  let lang = language->Option.getOr("")
  "```" ++ lang ++ "\n" ++ text->escapeMarkdown ++ "\n```"
}
let link = (text, url) => "[" ++ text->escapeMarkdown ++ "](" ++ url->escapeMarkdown ++ ")"
let mention = (text, userId) =>
  "[" ++ text->escapeMarkdown ++ "](tg://user?id=" ++ Int.toString(userId) ++ ")"
