/** Pixels RGBA de uma imagem, 4 bytes cada, linha a linha. */
export type Pixels = { largura: number; altura: number; rgba: Uint8Array }

/** A cor padrão do terminal numa célula de `Raster` (o bit 24 sozinho). */
const PADRAO = 0x01000000
const MEIO_DE_CIMA = 0x2580
const MEIO_DE_BAIXO = 0x2584
const ESPACO = 0x20
/** Abaixo deste alfa o pixel conta como transparente e deixa aparecer o fundo do terminal. */
const OPACO = 128
const FIM_DO_CABECALHO = 'ENDHDR\n'

/** Lê o PAM (P7) que o ffmpeg grava: RGB_ALPHA ou RGB, 8 bits por canal. */
export function lerPam(bytes: Uint8Array): Pixels | undefined {
  let texto = ''
  for (let i = 0; i < Math.min(bytes.length, 512); i++) texto += String.fromCharCode(bytes[i]!)
  const fim = texto.indexOf(FIM_DO_CABECALHO)
  if (!texto.startsWith('P7\n') || fim < 0) return undefined

  const campos = new Map<string, string>()
  for (const linha of texto.slice(3, fim).split('\n')) {
    const [nome, ...valor] = linha.trim().split(/\s+/)
    if (nome) campos.set(nome, valor.join(' '))
  }
  const largura = Number(campos.get('WIDTH'))
  const altura = Number(campos.get('HEIGHT'))
  const profundidade = Number(campos.get('DEPTH'))
  if (!(largura > 0 && altura > 0) || (profundidade !== 3 && profundidade !== 4)) return undefined
  if (campos.get('MAXVAL') !== '255') return undefined

  const inicio = fim + FIM_DO_CABECALHO.length
  const total = largura * altura
  if (bytes.length - inicio < total * profundidade) return undefined
  if (profundidade === 4) return { largura, altura, rgba: bytes.slice(inicio, inicio + total * 4) }

  const rgba = new Uint8Array(total * 4)
  for (let p = 0; p < total; p++) {
    rgba[p * 4] = bytes[inicio + p * 3]!
    rgba[p * 4 + 1] = bytes[inicio + p * 3 + 1]!
    rgba[p * 4 + 2] = bytes[inicio + p * 3 + 2]!
    rgba[p * 4 + 3] = 255
  }

  return { largura, altura, rgba }
}

/**
 * Quantas colunas e linhas de terminal a miniatura ocupa dentro de `maxColunas` × `maxLinhas`,
 * sem distorcer: cada célula mostra 2 pixels na vertical (um meio-bloco), e a imagem nunca é
 * ampliada além de 1 pixel por meia célula.
 */
export function caber(largura: number, altura: number, maxColunas: number, maxLinhas: number): { colunas: number; linhas: number } {
  const escala = Math.min(maxColunas / largura, (maxLinhas * 2) / altura, 1)

  return {
    colunas: Math.max(1, Math.min(maxColunas, Math.round(largura * escala))),
    linhas: Math.max(1, Math.min(maxLinhas, Math.round((altura * escala) / 2))),
  }
}

/** Reduz (ou amplia) para `largura` × `altura` pela média da área, com a cor pesada pelo alfa. */
export function reduzir(px: Pixels, largura: number, altura: number): Pixels {
  const rgba = new Uint8Array(largura * altura * 4)
  const passoX = px.largura / largura
  const passoY = px.altura / altura
  for (let y = 0; y < altura; y++) {
    const y0 = Math.floor(y * passoY)
    const y1 = Math.min(px.altura, Math.max(y0 + 1, Math.floor((y + 1) * passoY)))
    for (let x = 0; x < largura; x++) {
      const x0 = Math.floor(x * passoX)
      const x1 = Math.min(px.largura, Math.max(x0 + 1, Math.floor((x + 1) * passoX)))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * px.largura + xx) * 4
          const alfa = px.rgba[i + 3]!
          r += px.rgba[i]! * alfa
          g += px.rgba[i + 1]! * alfa
          b += px.rgba[i + 2]! * alfa
          a += alfa
          n++
        }
      }
      const o = (y * largura + x) * 4
      if (a > 0) {
        rgba[o] = Math.round(r / a)
        rgba[o + 1] = Math.round(g / a)
        rgba[o + 2] = Math.round(b / a)
      }
      rgba[o + 3] = n > 0 ? Math.round(a / n) : 0
    }
  }

  return { largura, altura, rgba }
}

/**
 * As células de um `Raster` (RasterProps `cells`): um meio-bloco por célula, o pixel de cima na
 * frente e o de baixo no fundo; onde o pixel é transparente fica o fundo do terminal.
 *
 * `px` já vem no tamanho da miniatura: `colunas` × `linhas * 2`.
 */
export function celulas(px: Pixels): string {
  const linhas = Math.ceil(px.altura / 2)
  const palavras = new Uint32Array(px.largura * linhas * 3)
  for (let l = 0; l < linhas; l++) {
    for (let c = 0; c < px.largura; c++) {
      const cima = cor(px, c, l * 2)
      const baixo = l * 2 + 1 < px.altura ? cor(px, c, l * 2 + 1) : undefined
      const k = (l * px.largura + c) * 3
      if (cima !== undefined) {
        palavras[k] = MEIO_DE_CIMA
        palavras[k + 1] = cima
        palavras[k + 2] = baixo ?? PADRAO
      } else if (baixo !== undefined) {
        palavras[k] = MEIO_DE_BAIXO
        palavras[k + 1] = baixo
        palavras[k + 2] = PADRAO
      } else {
        palavras[k] = ESPACO
        palavras[k + 1] = PADRAO
        palavras[k + 2] = PADRAO
      }
    }
  }

  return paraBase64(new Uint8Array(palavras.buffer))
}

/** A cor `0x00RRGGBB` do pixel, ou undefined quando ele é transparente. */
function cor(px: Pixels, x: number, y: number): number | undefined {
  const i = (y * px.largura + x) * 4
  if (px.rgba[i + 3]! < OPACO) return undefined

  return (px.rgba[i]! << 16) | (px.rgba[i + 1]! << 8) | px.rgba[i + 2]!
}

export function paraBase64(bytes: Uint8Array): string {
  let texto = ''
  for (let i = 0; i < bytes.length; i += 0x8000) texto += String.fromCharCode(...bytes.subarray(i, i + 0x8000))

  return btoa(texto)
}

export function deBase64(base64: string): Uint8Array {
  const texto = atob(base64)
  const bytes = new Uint8Array(texto.length)
  for (let i = 0; i < texto.length; i++) bytes[i] = texto.charCodeAt(i)

  return bytes
}
