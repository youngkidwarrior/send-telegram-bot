type t = string

let escape = MessageFormat.escapeMarkdown

let text = (s: string): t => escape(s)
let bold = (s: t): t => "*" ++ s ++ "*"
let concat = (parts: array<t>): t => parts->Array.join("")
let newline: t = "\n"
let divider: t = "┃ ━━━━━━━━━━"

// Prefix we currently render as a backticked header line: "`\n┃ `"
let codeHeaderPrefix: t = "`\n┃ `"

let senderLine = (~padding: int, ~senderName: t): t => {
  let pad = {
    let rec aux = (i, acc) =>
      if i <= 0 {
        acc
      } else {
        aux(i - 1, acc ++ " ")
      }
    aux(padding, "")
  }
  "\n┃ " ++ pad ++ "`sent by " ++ senderName ++ "`"
}

let mentionUserId = (id: int): t => "[‎](tg://user?id=" ++ Int.toString(id) ++ ")"

let render = (s: t): string => s
