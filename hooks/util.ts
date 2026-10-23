import { paraBase64 } from './pixels'

/** O marcador que o Claude Code põe no prompt no lugar de uma imagem colada. */
const MARCADOR = /\[Image #(\d+)[^\]]*\]/g

/** Os números dos marcadores `[Image #N]` do texto, sem repetir, na ordem em que aparecem. */
export function numerosDeImagem(texto: string): number[] {
  const numeros: number[] = []
  for (const achado of texto.matchAll(MARCADOR)) {
    const n = Number(achado[1])
    if (n > 0 && !numeros.includes(n)) numeros.push(n)
  }

  return numeros
}

/** O texto em UTF-16LE e base64: o que o `-EncodedCommand` do PowerShell lê. */
export function utf16Base64(texto: string): string {
  const bytes = new Uint8Array(texto.length * 2)
  for (let i = 0; i < texto.length; i++) {
    const codigo = texto.charCodeAt(i)
    bytes[i * 2] = codigo & 0xff
    bytes[i * 2 + 1] = codigo >> 8
  }

  return paraBase64(bytes)
}
