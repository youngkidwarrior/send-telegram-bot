type t

let parse: string => option<t>
let ofFirstName: string => option<t>
let toParam: t => string
let toDisplay: t => string
