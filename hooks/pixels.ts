/** Pixels RGBA de uma imagem, 4 bytes cada, linha a linha. */
export type Pixels = { largura: number; altura: number; rgba: Uint8Array }

type Cor = [number, number, number]

/** A cor padrão do terminal numa célula de `Raster` (o bit 24 sozinho). */
const PADRAO = 0x01000000
const ESPACO = 0x20
/**
 * O caractere de cada combinação de quadrantes na frente, pela máscara: 8 em cima à esquerda,
 * 4 em cima à direita, 2 embaixo à esquerda, 1 embaixo à direita (0 nenhum, 15 o bloco cheio).
 */
const QUADRANTES = [
  ESPACO, 0x2597, 0x2596, 0x2584, 0x259d, 0x2590, 0x259e, 0x259f,
  0x2598, 0x259a, 0x258c, 0x2599, 0x2580, 0x259c, 0x259b, 0x2588,
]
/** Lado da amostra de cada célula: 8×8 pixels, a resolução dos blocos de oitavos. */
export const AMOSTRA = 8

/**
 * Os blocos que o desenho escolhe, com os pixels da amostra (0 a 63, linha a linha) que cada um
 * pinta com a cor da frente: o cheio primeiro, depois os oitavos de baixo (`▁▂▃▄▅▆▇`) e da
 * esquerda (`▏▎▍▌▋▊▉`), os quadrantes e as diagonais. Um só de cada par que troca frente e fundo.
 */
const BLOCOS = (() => {
  const bloco = (codigo: number, pinta: (x: number, y: number) => boolean) => {
    const frente: number[] = []
    for (let i = 0; i < AMOSTRA * AMOSTRA; i++) if (pinta(i % AMOSTRA, Math.floor(i / AMOSTRA))) frente.push(i)

    return { codigo, frente }
  }
  const oitavos = [1, 2, 3, 4, 5, 6, 7]

  return [
    bloco(0x2588, () => true),
    ...oitavos.map(k => bloco(0x2580 + k, (_, y) => y >= AMOSTRA - k)),
    ...oitavos.map(k => bloco(0x2590 - k, x => x < k)),
    bloco(0x2598, (x, y) => x < 4 && y < 4),
    bloco(0x259d, (x, y) => x >= 4 && y < 4),
    bloco(0x2596, (x, y) => x < 4 && y >= 4),
    bloco(0x2597, (x, y) => x >= 4 && y >= 4),
    bloco(0x259a, (x, y) => (x < 4) === (y < 4)),
    bloco(0x259e, (x, y) => (x < 4) !== (y < 4)),
  ]
})()
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
 * As células de um `Raster` (RasterProps `cells`): cada célula resume 8×8 pixels num bloco de
 * oitavos ou de quadrantes e no par de cores que melhor os separa, com as bordas a 1/8 de célula.
 * Onde a célula é transparente fica o fundo do terminal.
 *
 * `px` já vem no tamanho da miniatura: `colunas * AMOSTRA` × `linhas * AMOSTRA`.
 */
export function celulas(px: Pixels): string {
  const colunas = Math.ceil(px.largura / AMOSTRA)
  const linhas = Math.ceil(px.altura / AMOSTRA)
  const palavras = new Uint32Array(colunas * linhas * 3)
  const amostra: (Cor | undefined)[] = new Array(AMOSTRA * AMOSTRA)
  for (let l = 0; l < linhas; l++) {
    for (let c = 0; c < colunas; c++) {
      for (let i = 0; i < amostra.length; i++) amostra[i] = pixel(px, c * AMOSTRA + (i % AMOSTRA), l * AMOSTRA + Math.floor(i / AMOSTRA))
      palavras.set(celula(amostra), (l * colunas + c) * 3)
    }
  }

  return paraBase64(new Uint8Array(palavras.buffer))
}

/** O caractere, a frente e o fundo de uma célula a partir da sua amostra (undefined: transparente). */
function celula(amostra: (Cor | undefined)[]): [number, number, number] {
  const opacos = amostra.filter((c): c is Cor => c !== undefined)
  if (opacos.length === 0) return [ESPACO, PADRAO, PADRAO]
  if (opacos.length < amostra.length) return comTransparencia(amostra, opacos)

  // O melhor bloco é o que mais "explica" as cores: maximiza |soma da frente|²/n + |soma do fundo|²/n.
  const total = somar(opacos)
  let melhor = { valor: -Infinity, codigo: 0x2588, frente: total, nFrente: 1, fundo: total, nFundo: 1 }
  for (const bloco of BLOCOS) {
    const frente = somar(bloco.frente.map(i => amostra[i]!))
    const fundo: Cor = [total[0] - frente[0], total[1] - frente[1], total[2] - frente[2]]
    const nFrente = bloco.frente.length
    const nFundo = amostra.length - nFrente
    const valor = quadrado(frente) / nFrente + (nFundo > 0 ? quadrado(fundo) / nFundo : 0)
    if (valor > melhor.valor + 1e-3) melhor = { valor, codigo: bloco.codigo, frente, nFrente, fundo, nFundo }
  }
  const frente = dividir(melhor.frente, melhor.nFrente)

  return [melhor.codigo, rgb(frente), melhor.nFundo > 0 ? rgb(dividir(melhor.fundo, melhor.nFundo)) : rgb(frente)]
}

/** Célula com parte transparente: cada quadrante opaco na frente (média), o resto com o fundo do terminal. */
function comTransparencia(amostra: (Cor | undefined)[], opacos: Cor[]): [number, number, number] {
  let mascara = 0
  for (let q = 0; q < 4; q++) {
    let cheios = 0
    for (let i = 0; i < amostra.length; i++) {
      const x = i % AMOSTRA
      const y = Math.floor(i / AMOSTRA)
      if ((x >= AMOSTRA / 2 ? 1 : 0) + (y >= AMOSTRA / 2 ? 2 : 0) === q && amostra[i] !== undefined) cheios++
    }
    if (cheios * 8 >= amostra.length) mascara |= 8 >> q
  }
  if (mascara === 0) return [ESPACO, PADRAO, PADRAO]

  return [QUADRANTES[mascara]!, rgb(dividir(somar(opacos), opacos.length)), PADRAO]
}

/** O pixel como cor, ou undefined quando é transparente ou fica fora da imagem. */
function pixel(px: Pixels, x: number, y: number): Cor | undefined {
  if (x >= px.largura || y >= px.altura) return undefined
  const i = (y * px.largura + x) * 4
  if (px.rgba[i + 3]! < OPACO) return undefined

  return [px.rgba[i]!, px.rgba[i + 1]!, px.rgba[i + 2]!]
}

function somar(cores: Cor[]): Cor {
  const soma: Cor = [0, 0, 0]
  for (const c of cores) {
    soma[0] += c[0]
    soma[1] += c[1]
    soma[2] += c[2]
  }

  return soma
}

function quadrado(c: Cor): number {
  return c[0] * c[0] + c[1] * c[1] + c[2] * c[2]
}

function dividir(c: Cor, n: number): Cor {
  return [Math.round(c[0] / n), Math.round(c[1] / n), Math.round(c[2] / n)]
}

/** A cor no formato do `Raster`: `0x00RRGGBB`. */
function rgb(c: Cor): number {
  return (c[0] << 16) | (c[1] << 8) | c[2]
}

/**
 * Realça o contorno depois de reduzir (máscara de nitidez com os 4 vizinhos), para a miniatura
 * pequena não ficar embaçada. `forca` 0 deixa como está; o alfa não muda, e perto de pixel
 * transparente nada é mexido.
 */
export function realcar(px: Pixels, forca: number): Pixels {
  const { largura, altura, rgba } = px
  const saida = new Uint8Array(rgba)
  const em = (x: number, y: number) => (Math.min(altura - 1, Math.max(0, y)) * largura + Math.min(largura - 1, Math.max(0, x))) * 4
  for (let y = 0; y < altura; y++) {
    for (let x = 0; x < largura; x++) {
      const vizinhos = [em(x, y - 1), em(x, y + 1), em(x - 1, y), em(x + 1, y)]
      const i = em(x, y)
      if (rgba[i + 3]! < OPACO || vizinhos.some(v => rgba[v + 3]! < OPACO)) continue
      for (let k = 0; k < 3; k++) {
        const borda = 4 * rgba[i + k]! - vizinhos.reduce((s, v) => s + rgba[v + k]!, 0)
        saida[i + k] = Math.max(0, Math.min(255, Math.round(rgba[i + k]! + (forca * borda) / 4)))
      }
    }
  }

  return { largura, altura, rgba: saida }
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
