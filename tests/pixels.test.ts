import { expect, test } from 'claude-code/testing'

import { caber, celulas, lerPam, reduzir } from '../hooks/pixels'
import { numerosDeImagem } from '../hooks/util'

const PADRAO = 0x01000000
const MEIO_DE_CIMA = 0x2580
const MEIO_DE_BAIXO = 0x2584

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

test('cada célula é um meio-bloco: a cor de cima na frente, a de baixo no fundo', () => {
  const px = lerPam(pam(1, 2, 4, [255, 0, 0, 255, 0, 0, 255, 255]))!

  expect(triplas(celulas(px))).toEqual([[MEIO_DE_CIMA, 0xff0000, 0x0000ff]])
})

test('pixel transparente deixa aparecer o fundo do terminal', () => {
  const emCima = lerPam(pam(1, 2, 4, [0, 0, 0, 0, 0, 255, 0, 255]))!
  const embaixo = lerPam(pam(1, 2, 4, [0, 255, 0, 255, 0, 0, 0, 0]))!
  const nenhum = lerPam(pam(1, 2, 4, [0, 0, 0, 0, 0, 0, 0, 0]))!
  const altura1 = lerPam(pam(1, 1, 4, [9, 9, 9, 255]))!

  expect(triplas(celulas(emCima))).toEqual([[MEIO_DE_BAIXO, 0x00ff00, PADRAO]])
  expect(triplas(celulas(embaixo))).toEqual([[MEIO_DE_CIMA, 0x00ff00, PADRAO]])
  expect(triplas(celulas(nenhum))).toEqual([[0x20, PADRAO, PADRAO]])
  expect(triplas(celulas(altura1))).toEqual([[MEIO_DE_CIMA, 0x090909, PADRAO]])
})

test('acha os números dos marcadores de imagem, sem repetir', () => {
  expect(numerosDeImagem('a [Image #6] b [Image #7] c [Image #6]')).toEqual([6, 7])
  expect(numerosDeImagem('[Image #0] [Imagem #3] [Image #x] [Image #12]')).toEqual([12])
  expect(numerosDeImagem('sem imagem')).toEqual([])
})
