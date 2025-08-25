type t = string

let clean = (raw: string) =>
  raw
  ->String.replaceRegExp(RegExp.fromString("[\\n>].*$"), "") // remove from first newline or '>' to end
  ->String.replaceRegExp(RegExp.fromString("^/+", ~flags="g"), "")
  ->String.replaceRegExp(RegExp.fromString("[^A-Za-z0-9_]", ~flags="g"), "")
  ->(s =>
    if String.length(s) > 20 {
      s->String.slice(~start=0, ~end=20)
    } else {
      s
    })
  ->String.trim

let parse = (s: string) => {
  let c = clean(s)
  if c == "" {
    None
  } else {
    Some(c)
  }
}

let ofFirstName = (first: string) => {
  let parts = first->String.split("/")
  switch parts->Array.get(1) {
  | Some(tag) => parse(tag)
  | None => None
  }
}

let toParam = (t: t) => t
let toDisplay = (t: t) => "/" ++ t
