/**
 * Traduz o resultado das tentativas de PTZ numa CAUSA em português.
 *
 * O que o operador via antes, numa caixa vermelha:
 *
 *   "Nenhum endpoint PTZ aceitou o comando. Tentativas: cgi-bin/ptz.cgi:
 *    Nenhum endpoint proprietário aceitou o comando. | /onvif/ptz_service
 *    Profile000 (relative): Câmera retornou falha SOAP para o comando PTZ. |
 *    /onvif/ptz_service Profile000: Câmera retornou falha SOAP..."
 *
 * Quatro tentativas concatenadas, em jargão, sem dizer o que fazer. O detalhe
 * técnico continua existindo — só sai da cara de quem está operando e vai para
 * um campo próprio, que o painel de diagnóstico e o log usam.
 *
 * A classificação olha o CONJUNTO das tentativas, não a última: "todas falharam
 * por SOAP Fault" e "nenhuma porta respondeu" são problemas diferentes, com
 * ações diferentes, e antes viravam a mesma parede de texto.
 */

export type CausaPtz =
  | 'sem-suporte'
  | 'credencial'
  | 'inalcancavel'
  | 'perfil-errado'
  | 'indeterminada';

export type DiagnosticoPtz = {
  causa: CausaPtz;
  /** Frase para o operador: o que houve e o que fazer. */
  mensagem: string;
  /** As tentativas cruas, para diagnóstico técnico — nunca para a tela principal. */
  detalhesTecnicos: string[];
};

const contem = (textos: string[], ...termos: string[]) =>
  textos.some((t) => {
    const baixo = t.toLowerCase();
    return termos.some((termo) => baixo.includes(termo.toLowerCase()));
  });

const todos = (textos: string[], ...termos: string[]) =>
  textos.length > 0 &&
  textos.every((t) => {
    const baixo = t.toLowerCase();
    return termos.some((termo) => baixo.includes(termo.toLowerCase()));
  });

export function diagnosticarFalhaPtz(tentativas: string[]): DiagnosticoPtz {
  const detalhesTecnicos = tentativas.slice();

  if (!tentativas.length) {
    return {
      causa: 'indeterminada',
      mensagem: 'Não foi possível enviar o comando para a câmera. Tente novamente em alguns segundos.',
      detalhesTecnicos,
    };
  }

  // Credencial vem primeiro: é o único caso em que a câmera RESPONDE e recusa
  // por identidade. Confundir isto com "não tem PTZ" manda o operador trocar
  // equipamento quando bastava corrigir a senha.
  if (contem(tentativas, 'auth não é digest', '401', 'unauthorized', 'não autorizado')) {
    return {
      causa: 'credencial',
      mensagem:
        'A câmera recusou o usuário e a senha do ONVIF. Confira as credenciais no cadastro da câmera — '
        + 'em muitos equipamentos o usuário do ONVIF é diferente do usuário da interface web.',
      detalhesTecnicos,
    };
  }

  // Nada respondeu em porta nenhuma: é rede/equipamento, não capacidade.
  if (todos(tentativas, 'unreachable', 'timeout', 'indisponíve', 'bloqueado pela política')) {
    return {
      causa: 'inalcancavel',
      mensagem:
        'A câmera não respondeu no endereço e nas portas configuradas. Verifique se ela está online e '
        + 'se a porta ONVIF do cadastro está correta.',
      detalhesTecnicos,
    };
  }

  // A câmera respondeu e recusou o comando em TODAS as combinações de caminho e
  // perfil. É o padrão de equipamento fixo — que era exatamente o caso da tela
  // de PTZ listando câmera sem PTZ.
  if (todos(tentativas, 'soap', 'não parece compatível', 'nenhum endpoint proprietário')) {
    return {
      causa: 'sem-suporte',
      mensagem:
        'Esta câmera respondeu, mas recusou todos os comandos de movimento — o modelo provavelmente é fixo, '
        + 'sem PTZ. Se você tem certeza de que ela se move, marque o PTZ manualmente no editor avançado da câmera.',
      detalhesTecnicos,
    };
  }

  // Parte das tentativas passou de perfil e parte não: cheira a token errado.
  if (contem(tentativas, 'profile') && contem(tentativas, 'soap')) {
    return {
      causa: 'perfil-errado',
      mensagem:
        'A câmera aceitou a conexão mas recusou o perfil de mídia usado para PTZ. '
        + 'Rode a detecção novamente no editor avançado para o sistema descobrir o perfil correto.',
      detalhesTecnicos,
    };
  }

  return {
    causa: 'indeterminada',
    mensagem:
      'A câmera não aceitou o comando de movimento. Rode a detecção de PTZ no editor avançado para o '
      + 'sistema tentar redescobrir como falar com este equipamento.',
    detalhesTecnicos,
  };
}
