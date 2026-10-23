import { expect, test } from 'claude-code/testing'

import { caber, celulas, lerPam, realcar, reduzir } from '../hooks/pixels'
import { numerosDeImagem, utf16Base64 } from '../hooks/util'

const PADRAO = 0x01000000
const VERMELHO = [255, 0, 0, 255]
const AZUL = [0, 0, 255, 255]
const VERDE = [0, 255, 0, 255]
const VAZIO = [0, 0, 0, 0]

/** Um PAM como o ffmpeg grava: cabeçalho de texto e os pixels crus. */
function pam(largura: number, altura: number, profundidade: 3 | 4, dados: number[]): Uint8Array {
  const tipo = profundidade === 4 ? 'RGB_ALPHA' : 'RGB'
  const cabecalho = `P7\nWIDTH ${largura}\nHEIGHT ${altura}\nDEPTH ${profundidade}\nMAXVAL 255\nTUPLTYPE ${tipo}\nENDHDR\n`
  const bytes = new Uint8Array(cabecalho.length + dados.length)
  for (let i = 0; i < cabecalho.length; i++) bytes[i] = cabecalho.charCodeAt(i)
  bytes.set(dados, cabecalho.length)

  return bytes
}

/** As triplas `[código, frente, fundo]` de cada célula de um Raster. */
function triplas(base64: string): number[][] {
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
  const palavras = new Uint32Array(bytes.buffer)
  const lista: number[][] = []
  for (let i = 0; i < palavras.length; i += 3) lista.push([palavras[i]!, palavras[i + 1]!, palavras[i + 2]!])

  return lista
}

test('lê um PAM RGBA do ffmpeg', () => {
  const px = lerPam(pam(2, 1, 4, [255, 0, 0, 255, 0, 0, 255, 128]))

  expect(px?.largura).toBe(2)
  expect(px?.altura).toBe(1)
  expect([...(px?.rgba ?? [])]).toEqual([255, 0, 0, 255, 0, 0, 255, 128])
})

test('lê um PAM RGB e completa o alfa', () => {
  const px = lerPam(pam(1, 2, 3, [10, 20, 30, 40, 50, 60]))

  expect([...(px?.rgba ?? [])]).toEqual([10, 20, 30, 255, 40, 50, 60, 255])
})

test('lê o PAM BGR_ALPHA que o PowerShell grava no Windows, trocando o azul com o vermelho', () => {
  const cabecalho = 'P7\nWIDTH 2\nHEIGHT 1\nDEPTH 4\nMAXVAL 255\nTUPLTYPE BGR_ALPHA\nENDHDR\n'
  const dados = [10, 20, 30, 255, 40, 50, 60, 128]
  const bytes = new Uint8Array(cabecalho.length + dados.length)
  for (let i = 0; i < cabecalho.length; i++) bytes[i] = cabecalho.charCodeAt(i)
  bytes.set(dados, cabecalho.length)

  expect(Array.from(lerPam(bytes)!.rgba)).toEqual([30, 20, 10, 255, 60, 50, 40, 128])
})

test('recusa o que não é PAM', () => {
  expect(lerPam(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined()
  expect(lerPam(pam(4, 4, 4, [1, 2, 3]))).toBeUndefined()
})

test('a miniatura cabe na caixa sem distorcer, com 2 pixels por célula na vertical', () => {
  expect(caber(1500, 2000, 40, 10)).toEqual({ colunas: 15, linhas: 10 })
  expect(caber(1120, 157, 64, 10)).toEqual({ colunas: 64, linhas: 4 })
})

test('imagem pequena não é ampliada, e nada fica com menos de uma célula', () => {
  expect(caber(10, 4, 40, 10)).toEqual({ colunas: 10, linhas: 2 })
  expect(caber(1000, 1, 40, 10)).toEqual({ colunas: 40, linhas: 1 })
})

test('reduzir tira a média da área', () => {
  const px = lerPam(pam(2, 2, 4, [255, 0, 0, 255, 0, 0, 255, 255, 255, 0, 0, 255, 0, 0, 255, 255]))!
  const um = reduzir(px, 1, 1)

  expect([...um.rgba]).toEqual([128, 0, 128, 255])
})

test('reduzir pesa a cor pelo alfa, sem escurecer a borda transparente', () => {
  const px = lerPam(pam(2, 1, 4, [255, 0, 0, 255, 0, 255, 0, 0]))!

  expect([...reduzir(px, 1, 1).rgba]).toEqual([255, 0, 0, 128])
})

/** Uma célula como o mod a amostra, 8×8 pixels (ou mais células lado a lado, com `largura`). */
function celula8(cor: (x: number, y: number) => number[], largura = 8) {
  const dados: number[] = []
  for (let y = 0; y < 8; y++) for (let x = 0; x < largura; x++) dados.push(...cor(x, y))

  return lerPam(pam(largura, 8, 4, dados))!
}

test('cada célula mostra 8×8 pixels com o bloco e o par de cores que melhor os separam', () => {
  expect(triplas(celulas(celula8((_, y) => (y < 4 ? VERMELHO : AZUL))))).toEqual([[0x2584, 0x0000ff, 0xff0000]])
  expect(triplas(celulas(celula8(x => (x < 4 ? VERMELHO : AZUL))))).toEqual([[0x258c, 0xff0000, 0x0000ff]])
  expect(triplas(celulas(celula8((x, y) => (x < 4 && y < 4 ? VERMELHO : AZUL))))).toEqual([[0x2598, 0xff0000, 0x0000ff]])
  expect(triplas(celulas(celula8((x, y) => ((x < 4) === (y < 4) ? VERMELHO : AZUL))))).toEqual([[0x259a, 0xff0000, 0x0000ff]])
})

test('os blocos de oitavos põem a borda a 1/8 de célula', () => {
  expect(triplas(celulas(celula8(x => (x < 3 ? VERMELHO : AZUL))))).toEqual([[0x258d, 0xff0000, 0x0000ff]])
  expect(triplas(celulas(celula8((_, y) => (y >= 7 ? VERDE : AZUL))))).toEqual([[0x2581, 0x00ff00, 0x0000ff]])
  expect(triplas(celulas(celula8((_, y) => (y >= 2 ? VERDE : AZUL))))).toEqual([[0x2586, 0x00ff00, 0x0000ff]])
})

test('célula de uma cor só vira um bloco cheio daquela cor', () => {
  expect(triplas(celulas(celula8(() => VERDE)))).toEqual([[0x2588, 0x00ff00, 0x00ff00]])
})

test('com mais de duas cores a célula fica com as duas médias mais fiéis', () => {
  const px = celula8((x, y) => (y < 4 ? VERMELHO : x < 4 ? [0, 0, 200, 255] : [0, 0, 100, 255]))

  expect(triplas(celulas(px))).toEqual([[0x2584, 0x000096, 0xff0000]])
})

test('pixel transparente deixa aparecer o fundo do terminal', () => {
  expect(triplas(celulas(celula8((_, y) => (y < 4 ? VAZIO : VERDE))))).toEqual([[0x2584, 0x00ff00, PADRAO]])
  expect(triplas(celulas(celula8((x, y) => (x < 4 && y < 4 ? VERDE : VAZIO))))).toEqual([[0x2598, 0x00ff00, PADRAO]])
  expect(triplas(celulas(celula8(() => VAZIO)))).toEqual([[0x20, PADRAO, PADRAO]])
})

test('as células seguem linha a linha, cada uma com 8 pixels de largura e 8 de altura', () => {
  const px = celula8(x => (x < 8 ? VERMELHO : AZUL), 16)

  expect(triplas(celulas(px))).toEqual([
    [0x2588, 0xff0000, 0xff0000],
    [0x2588, 0x0000ff, 0x0000ff],
  ])
})

test('realçar aumenta o contraste de um ponto com a vizinhança, sem passar de 255', () => {
  const ponto = (centro: number, vizinho: number) =>
    lerPam(pam(3, 3, 3, [...Array(9).keys()].flatMap(i => (i === 4 ? [centro, centro, centro] : [vizinho, vizinho, vizinho]))))!

  expect(realcar(ponto(200, 100), 0.4).rgba[16]).toBe(240)
  expect(realcar(ponto(250, 0), 0.4).rgba[16]).toBe(255)
  expect(realcar(ponto(200, 100), 0.4).rgba[19]).toBe(255)
  expect([...realcar(ponto(100, 100), 0.4).rgba]).toEqual([...ponto(100, 100).rgba])
})

test('acha os números dos marcadores de imagem, sem repetir', () => {
  expect(numerosDeImagem('a [Image #6] b [Image #7] c [Image #6]')).toEqual([6, 7])
  expect(numerosDeImagem('[Image #0] [Imagem #3] [Image #x] [Image #12]')).toEqual([12])
  expect(numerosDeImagem('sem imagem')).toEqual([])
})

test('codifica o script como o -EncodedCommand do PowerShell lê: UTF-16LE em base64', () => {
  expect(utf16Base64('ab')).toBe('YQBiAA==')
  expect(utf16Base64('ã')).toBe('4wA=')
})
