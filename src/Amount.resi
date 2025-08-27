// Strongly typed amounts
// `tokens` are whole-token values (e.g., 150 SEND)
// `units` are base units (e.g., wei-like 150 * 10^18)

type tokens

type units

type display = string

type verified = {units: units, display: display}

// Constructors and accessors
let tokensOfBigint: bigint => tokens
let tokensValue: tokens => bigint
let unitsValue: units => bigint

// Conversions
let unitsOfTokens: tokens => units
let verifiedOfTokens: tokens => verified

// Parsing and formatting
let parse: string => option<verified>
let formatUnits: units => string
let displayToMd: display => Markdown.t
