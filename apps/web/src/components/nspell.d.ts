declare module 'nspell' {
  interface NSpell {
    correct: (word: string) => boolean;
    suggest: (word: string) => string[];
    add: (word: string) => NSpell;
  }
  export default function nspell(aff: string, dic: string): NSpell;
}
declare module '*.aff?url' {
  const url: string;
  export default url;
}
declare module '*.dic?url' {
  const url: string;
  export default url;
}
