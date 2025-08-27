// Token config for SEND
let decimals: bigint = 18n

// Strongly typed amount wrappers

type tokens = Tokens(bigint)

type units = Units(bigint)

type display = string

type verified = {units: units, display: display}

// Constructors and accessors
let tokensOfBigint = (b: bigint): tokens => Tokens(b)
let tokensValue = (t: tokens): bigint =>
  switch t {
  | Tokens(b) => b
  }
let unitsValue = (u: units): bigint =>
  switch u {
  | Units(b) => b
  }

// Conversions
let unitsOfTokens = (t: tokens): units => Units(tokensValue(t) * 10n ** decimals)
let verifiedOfTokens = (t: tokens): verified => {
  let display = tokensValue(t)->BigInt.toString
  {units: unitsOfTokens(t), display}
}

let parse = (input: string): option<verified> => {
  let s = input->String.trim
  if s == "" {
    None
  } else {
    let parts = s->String.split(".")
    switch parts->Array.length {
    | 1 =>
      switch parts->Array.get(0) {
      | Some(intStr) =>
        switch BigInt.fromString(intStr) {
        | Some(intPart) => Some({units: Units(intPart * 10n ** decimals), display: s})
        | None => None
        }
      | None => None
      }
    | 2 => {
        let intStr = parts->Array.get(0)->Option.getOr("")
        let fracRaw = parts->Array.get(1)->Option.getOr("")
        let intOk = intStr == "" || intStr->String.match(RegExp.fromString("^\\d+$"))->Option.isSome
        let decimalsInt = 18
        let fracLimited = if String.length(fracRaw) > decimalsInt {
          fracRaw->String.slice(~start=0, ~end=decimalsInt)
        } else {
          fracRaw
        }
        let fracOk =
          fracLimited == "" || fracLimited->String.match(RegExp.fromString("^\\d+$"))->Option.isSome
        if !intOk || !fracOk {
          None
        } else {
          let padZeros = decimalsInt - String.length(fracLimited)
          let fracUnits = if fracLimited == "" {
            0n
          } else {
            switch BigInt.fromString(fracLimited) {
            | Some(bi) => bi * 10n ** BigInt.fromInt(padZeros)
            | None => 0n
            }
          }
          let intUnits = if intStr == "" {
            0n
          } else {
            switch BigInt.fromString(intStr) {
            | Some(bi) => bi * 10n ** decimals
            | None => 0n
            }
          }
          Some({units: Units(intUnits + fracUnits), display: s})
        }
      }
    | _ => None
    }
  }
}

let formatUnits = (u: units): string => {
  let divisor = 10n ** decimals
  let integer = unitsValue(u) / divisor
  BigInt.toString(integer)
}

let displayToMd = (d: display): Markdown.t => Markdown.text(d)
