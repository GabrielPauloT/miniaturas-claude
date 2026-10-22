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
