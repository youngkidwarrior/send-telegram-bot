type units = bigint

type display = string

type verified = {units: units, display: display}

let parse: string => option<verified>
let formatUnits: units => string
let displayToMd: display => Markdown.t
