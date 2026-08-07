/**
 * O MODO DE IA DE CADA CÂMERA — deixou de ser um só para a frota inteira.
 *
 * `AiSettings.mode` é uma linha única no banco, e a API mandava o mesmo valor
 * para as 27 câmeras. Com o escopo de objeto (ver escopo-de-objeto.helper),
 * cada câmera tem uma resposta diferente para "vale a pena rodar YOLO aqui?",
 * e mandar o modo global anulava essa decisão: ou todas pagavam, ou nenhuma
 * detectava.
 *
 * A REGRA É SÓ DE SUBIDA. O modo global continua sendo o piso; a câmera que
 * roda objeto é promovida a `general`. Nunca o contrário — rebaixar por conta
 * própria uma câmera que o operador colocou em `general` global seria desfazer
 * uma escolha explícita dele.
 */

export type ModoDeIa = 'motion' | 'general' | 'face';

export function modoDaCamera(modoGlobal: string | null | undefined, rodaObjeto: boolean): ModoDeIa {
  const global = (modoGlobal === 'general' || modoGlobal === 'face' ? modoGlobal : 'motion') as ModoDeIa;
  // `face` é mais específico que `general` e já implica detector pesado: subir
  // dali para "general" seria REBAIXAR o que a instalação pediu.
  if (global !== 'motion') return global;
  return rodaObjeto ? 'general' : 'motion';
}

/**
 * A câmera com detecção NATIVA deve ser pulada?
 *
 * O atalho original: câmera que detecta movimento sozinha (ONVIF) não precisa
 * da nossa MOG2 — é o que evita gastar CPU replicando o que o equipamento já
 * faz. Mas ele foi escrito quando "rodar IA" só significava movimento.
 *
 * Com objeto no quadro, aplicá-lo cegamente deixaria de fora exatamente as 17
 * câmeras da frota que usam evento nativo: elas nunca receberiam o YOLO, e a
 * linha de perímetro desenhada nelas não detectaria nada — com a tela dizendo
 * que estava tudo ativo.
 *
 * Então o atalho vale só quando NÃO há trabalho de objeto a fazer.
 */
export function devePularPorDeteccaoNativa(opcoes: {
  modoGlobal: string | null | undefined;
  motionTrigger: string | null | undefined;
  rodaObjeto: boolean;
  permitirGatilhoDaCamera?: boolean;
}): boolean {
  // Há objeto a processar → nunca pula, mesmo com detecção nativa.
  if (opcoes.rodaObjeto) return false;
  if (opcoes.permitirGatilhoDaCamera) return false;
  const global = opcoes.modoGlobal === 'general' || opcoes.modoGlobal === 'face' ? opcoes.modoGlobal : 'motion';
  return global === 'motion' && opcoes.motionTrigger !== 'SYSTEM';
}
