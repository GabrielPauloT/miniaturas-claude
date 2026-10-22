/** Uma imagem colada na sessão, pelo número do marcador `[Image #N]`. */
export type MiniaturaImagem = {
  /** O número do marcador. */
  n: number
  /**
   * `lendo` enquanto o ffmpeg trabalha; `pronta` com os pixels no cache; `sem-previa` quando
   * não há de onde ler a imagem antes do envio; `erro` com o motivo.
   */
  estado: 'lendo' | 'pronta' | 'sem-previa' | 'erro'
  /** De onde veio: a área de transferência na hora da colagem, ou o arquivo que o Claude Code enviou. */
  origem?: 'colagem' | 'enviada'
  /** A imagem inteira, para abrir no visualizador. */
  arquivo?: string
  /** Os pixels reduzidos (PAM, RGBA) no cache do mod. */
  pixels?: string
  /** Um PNG reduzido, para os terminais que desenham imagem (kitty, Ghostty). */
  png?: string
  /** O tamanho original, em pixels. */
  largura?: number
  altura?: number
  /** Muda a cada leitura, para o desenho pegar os pixels novos. */
  versao: number
  motivo?: string
}

declare module 'claude-code' {
  interface PluginState {
    miniaturas: {
      imagens: Record<string, MiniaturaImagem>
      /** Os números das imagens no rascunho do prompt, na ordem em que aparecem. */
      rascunho: number[]
      /** Os números da última mensagem enviada com imagem (modo fixa). */
      ultimas: number[]
    }
  }
}
