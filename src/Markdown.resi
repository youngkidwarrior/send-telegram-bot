type t

let text: string => t
let bold: t => t
let concat: array<t> => t
let newline: t
let divider: t
let codeHeaderPrefix: t
let senderLine: (~padding: int, ~senderName: t) => t
let mentionUserId: int => t
let render: t => string
