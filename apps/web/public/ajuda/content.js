(function () {
  const callout = (type, title, text) =>
    `<div class="callout ${type}"><span class="callout-title">${title}</span><p>${text}</p></div>`;

  window.AJUSTCAM_HELP = {
    product: "AjustCam",
    updatedAt: "30 de julho de 2026",
    categories: [
      {
        id: "primeiros-passos",
        title: "Primeiros passos",
        icon: "home",
        articles: [
          {
            id: "inicio",
            title: "Conheça o AjustCam",
            summary: "Uma visão geral do sistema, para quem ele serve e como encontrar cada recurso.",
            roles: ["Todos os perfis"],
            time: "5 min",
            keywords: "começar inicio sistema menu função visão geral câmera segurança",
            related: ["navegacao", "perfis-e-permissoes", "ao-vivo", "problemas-frequentes"],
            body: `
              <section class="doc-section">
                <h2>O que é o AjustCam</h2>
                <p>O AjustCam é o ambiente de operação da sua instalação de videomonitoramento. Nele você acompanha câmeras ao vivo, consulta gravações, trata alertas, controla câmeras móveis, organiza evidências e administra quem pode acessar cada função.</p>
                <p>Este guia foi escrito para proprietários, gestores e operadores. Ele explica o que aparece na tela, quando usar cada função e quais cuidados tomar durante a operação.</p>
                ${callout("info", "O que este guia não aborda", "Configurações internas, programação e manutenção de servidores não fazem parte deste material. Quando uma ação exigir conhecimento especializado, o guia indicará que ela deve ser encaminhada ao instalador ou suporte.")}
              </section>
              <section class="doc-section">
                <h2>Escolha o que você quer fazer</h2>
                <div class="home-grid">
                  <a class="home-card" href="#ao-vivo"><h3>Acompanhar câmeras</h3><p>Veja imagens em tempo real, altere o mosaico e abra uma câmera em destaque.</p><span class="card-arrow">Ir para Ao Vivo →</span></a>
                  <a class="home-card" href="#reproducao"><h3>Encontrar uma gravação</h3><p>Escolha câmera, data e horário, navegue pela linha do tempo e faça downloads permitidos.</p><span class="card-arrow">Ir para Reprodução →</span></a>
                  <a class="home-card" href="#alertas"><h3>Tratar uma ocorrência</h3><p>Entenda alertas ativos, reconheça eventos e registre quando a situação estiver resolvida.</p><span class="card-arrow">Ir para Alertas →</span></a>
                  <a class="home-card" href="#armazenamento"><h3>Acompanhar gravações</h3><p>Consulte espaço disponível, uso por câmera e estimativas de retenção.</p><span class="card-arrow">Ir para Armazenamento →</span></a>
                  <a class="home-card" href="#usuarios"><h3>Gerenciar acessos</h3><p>Crie usuários e aplique o perfil e o grupo adequados às responsabilidades de cada pessoa.</p><span class="card-arrow">Ir para Usuários →</span></a>
                  <a class="home-card" href="#aplicativo-movel"><h3>Usar no celular</h3><p>Acompanhe câmeras e alertas pelo aplicativo, respeitando as permissões da sua conta.</p><span class="card-arrow">Ir para o aplicativo →</span></a>
                </div>
              </section>
              <section class="doc-section">
                <h2>Como o acesso é organizado</h2>
                <p>Cada pessoa entra com sua própria conta. O que ela pode ver e fazer depende de três fatores: sua <strong>função</strong>, o <strong>grupo</strong> ao qual pertence e as <strong>câmeras</strong> liberadas para esse grupo.</p>
                <div class="role-grid">
                  <div class="role-card"><h3>Visualizador</h3><p>Acompanha imagens e consulta recursos liberados, sem administrar a instalação.</p></div>
                  <div class="role-card"><h3>Operador</h3><p>Conduz a rotina: monitora, trata alertas, consulta gravações e usa recursos operacionais autorizados.</p></div>
                  <div class="role-card"><h3>Administrador</h3><p>Gerencia pessoas, permissões, câmeras e configurações da instalação.</p></div>
                  <div class="role-card"><h3>Gestor ou proprietário</h3><p>Pode receber um perfil sob medida, com visão gerencial e somente as ações necessárias.</p></div>
                </div>
              </section>
              <section class="doc-section">
                <h2>Regras importantes de uso</h2>
                <ul>
                  <li>Use sempre sua própria conta e não compartilhe senha.</li>
                  <li>Antes de baixar ou compartilhar uma imagem, confirme a política de privacidade da sua empresa.</li>
                  <li>Não altere conexão, gravação ou retenção de câmeras durante uma ocorrência sem orientação.</li>
                  <li>Se uma opção descrita não aparecer, sua conta pode não ter permissão ou o recurso pode não estar habilitado.</li>
                  <li>Registre informações objetivas em alertas, investigações e evidências.</li>
                </ul>
              </section>`
          },
          {
            id: "navegacao",
            title: "Navegação e organização das telas",
            summary: "Como usar o menu, localizar recursos e entender os elementos que se repetem no sistema.",
            roles: ["Todos os perfis"],
            time: "4 min",
            keywords: "menu navegar barra lateral busca filtro botão tela",
            related: ["inicio", "perfis-e-permissoes", "status-e-indicadores"],
            body: `
              <section class="doc-section"><h2>Menu principal</h2><p>O menu lateral reúne as áreas disponíveis para sua conta. Em telas menores ele pode ficar recolhido; use o botão de menu no canto superior para abri-lo.</p><div class="feature-grid"><div class="feature-card"><h3>Monitoramento</h3><p>Ao Vivo, Reprodução, Revisão, Alertas e Controle PTZ.</p></div><div class="feature-card"><h3>Infraestrutura</h3><p>Câmeras e Armazenamento, quando liberados para seu perfil.</p></div><div class="feature-card"><h3>Administração</h3><p>Minha conta, Usuários, Grupos, Funções e Configurações.</p></div><div class="feature-card"><h3>Recursos complementares</h3><p>Investigações pode aparecer conforme o acesso e a configuração.</p></div></div></section>
              <section class="doc-section"><h2>Filtros e listas</h2><p>Filtros reduzem o que aparece sem apagar registros. Se uma lista parecer vazia, primeiro limpe os filtros de data, câmera, grupo, situação ou texto.</p><ol class="steps"><li><strong>Confira o período.</strong> Listas históricas costumam abrir em um intervalo recente.</li><li><strong>Confira o grupo ou câmera.</strong> Um filtro anterior pode ter permanecido selecionado.</li><li><strong>Veja sua permissão.</strong> A ausência de um item também pode indicar que ele não foi liberado para sua conta.</li></ol></section>
              <section class="doc-section"><h2>Ações e confirmações</h2><p>Botões que alteram a operação, como excluir, suspender, finalizar ou mudar configurações, podem solicitar confirmação. Leia o texto antes de prosseguir e não feche a tela enquanto a operação estiver sendo concluída.</p>${callout("warning", "Evite ações repetidas", "Ao perceber lentidão, aguarde a confirmação. Clicar várias vezes pode gerar solicitações duplicadas ou dificultar a identificação do resultado.")}</section>`
          },
          {
            id: "entrar-e-recuperar-acesso",
            title: "Entrar e recuperar o acesso",
            summary: "Como acessar a instalação, resolver uma senha esquecida e reconhecer uma tentativa indevida.",
            roles: ["Todos os perfis"],
            time: "4 min",
            keywords: "login entrar senha esqueci recuperar redefinir acesso bloqueado email",
            related: ["minha-conta", "perfis-e-permissoes", "problemas-frequentes"],
            body: `
              <section class="doc-section"><h2>Entrar no AjustCam</h2><ol class="steps"><li>Abra o endereço informado pela empresa.</li><li>Confirme que o nome da instalação está correto.</li><li>Informe seu usuário e sua senha.</li><li>Ao entrar, verifique se aparecem somente as câmeras e funções esperadas.</li></ol>${callout("warning", "Confira o endereço antes de digitar a senha", "Não use links recebidos de origem desconhecida. Em caso de dúvida, acesse pelo favorito aprovado pela empresa ou consulte o responsável.")}</section>
              <section class="doc-section"><h2>Esqueci minha senha</h2><p>Use a opção de recuperação apresentada na tela e siga as instruções enviadas ao contato cadastrado. A mensagem pode levar alguns minutos. Não solicite repetidamente e não encaminhe o conteúdo recebido para outra pessoa.</p><p>Se você não tiver mais acesso ao contato cadastrado, peça ao administrador que confirme sua identidade pelo procedimento da empresa. O administrador não deve solicitar sua senha antiga.</p></section>
              <section class="doc-section"><h2>Acesso bloqueado ou recusado</h2><p>Confira se não há erro de digitação e se a tecla de letras maiúsculas está desligada. Depois de poucas tentativas, pare e use a recuperação. Muitas tentativas podem prolongar o bloqueio de proteção.</p></section>
              <section class="doc-section"><h2>Mensagem de troca de senha que você não solicitou</h2><p>Não abra links inesperados. Informe imediatamente o responsável pela instalação, troque sua senha pelo endereço habitual do AjustCam e revise acessos recentes conforme o procedimento local.</p></section>`
          },
          {
            id: "perfis-e-permissoes",
            title: "Perfis, grupos e permissões",
            summary: "Entenda por que pessoas diferentes veem menus, câmeras e ações diferentes.",
            roles: ["Todos os perfis", "Administradores"],
            time: "5 min",
            keywords: "perfil permissão grupo visualizador operador administrador câmera acesso restrito suspenso",
            related: ["usuarios", "grupos", "funcoes", "acesso-e-privacidade"],
            body: `
              <section class="doc-section"><h2>Três camadas de acesso</h2><div class="feature-grid"><div class="feature-card"><h3>Função</h3><p>Define quais tipos de ação a pessoa pode realizar, como visualizar, exportar, controlar PTZ ou administrar.</p></div><div class="feature-card"><h3>Grupo</h3><p>Reúne pessoas e câmeras sob uma mesma regra de acesso.</p></div><div class="feature-card"><h3>Câmeras liberadas</h3><p>Determinam quais locais podem ser vistos pela pessoa dentro das ações permitidas.</p></div><div class="feature-card"><h3>Situação do acesso</h3><p>Pode liberar o uso normal, restringir o histórico ou suspender totalmente o acesso.</p></div></div></section>
              <section class="doc-section"><h2>Situações possíveis</h2><div class="status-list"><div class="status-row"><span class="status-label"><i class="status-dot green"></i>Liberado</span><p>Acesso normal às funções e câmeras permitidas.</p></div><div class="status-row"><span class="status-label"><i class="status-dot amber"></i>Restrito</span><p>A visualização ao vivo pode continuar disponível, mas o histórico fica bloqueado conforme a regra da instalação.</p></div><div class="status-row"><span class="status-label"><i class="status-dot red"></i>Suspenso</span><p>O acesso à instalação é interrompido.</p></div></div></section>
              <section class="doc-section"><h2>Se uma função não aparece</h2><p>Isso não significa necessariamente defeito. Confirme se a função está prevista para a pessoa, se o grupo está ativo e se a câmera pertence ao grupo correto. Mudanças de responsabilidade devem ser formalizadas antes de ampliar permissões.</p>${callout("info", "Princípio recomendado", "Conceda somente o acesso necessário para o trabalho da pessoa. Perfis sob medida são preferíveis a liberar administração completa.")}</section>`
          },
          {
            id: "minha-conta",
            title: "Minha conta e segurança de acesso",
            summary: "Como cuidar dos seus dados de acesso, senha, sessão e preferências pessoais.",
            roles: ["Todos os perfis"],
            time: "3 min",
            keywords: "conta perfil senha logout sair sessão nome email segurança",
            related: ["acesso-e-privacidade", "problemas-frequentes"],
            body: `
              <section class="doc-section"><h2>Dados da conta</h2><p>Em <strong>Minha conta</strong> você consulta os dados associados ao seu acesso e as opções pessoais disponibilizadas pela instalação. Dados que identificam sua função ou grupo normalmente são administrados por uma pessoa autorizada.</p></section>
              <section class="doc-section"><h2>Senha segura</h2><ul><li>Use uma senha exclusiva para o AjustCam.</li><li>Evite nomes, datas e sequências fáceis.</li><li>Não salve a senha em computadores compartilhados.</li><li>Troque-a imediatamente se suspeitar de acesso indevido.</li></ul>${callout("danger", "Nunca compartilhe sua conta", "O histórico de ações precisa representar quem realmente utilizou o sistema. Contas compartilhadas dificultam a apuração de ocorrências.")}</section>
              <section class="doc-section"><h2>Encerrar a sessão</h2><p>Ao terminar, use a opção <strong>Sair</strong>, especialmente em portarias, salas de controle ou equipamentos compartilhados. Apenas fechar a aba não deve ser tratado como substituto para sair da conta.</p></section>`
          }
        ]
      },
      {
        id: "monitoramento",
        title: "Monitoramento",
        icon: "monitor",
        articles: [
          {
            id: "ao-vivo",
            title: "Ao Vivo",
            summary: "Acompanhe câmeras em tempo real, organize o mosaico e entenda os controles de cada imagem.",
            roles: ["Visualizador", "Operador", "Administrador"],
            time: "8 min",
            keywords: "live ao vivo mosaico grade fps imagem câmera qualidade tela cheia áudio snapshot clip piscar carregando",
            related: ["modo-mural", "ptz", "status-e-indicadores", "problemas-frequentes"],
            body: `
              <section class="doc-section"><h2>Para que serve</h2><p>A tela <strong>Ao Vivo</strong> é o centro do monitoramento em tempo real. Ela permite acompanhar uma ou várias câmeras, escolher o formato do mosaico e destacar a imagem que precisa de atenção.</p></section>
              <section class="doc-section"><h2>Montar o mosaico</h2><ol class="steps"><li>Abra <strong>Ao Vivo</strong> no menu.</li><li>Escolha o formato de grade adequado à quantidade de câmeras.</li><li>Selecione ou arraste as câmeras disponíveis para as posições desejadas.</li><li>Clique duas vezes em uma imagem para destacá-la ou usar tela cheia.</li></ol><p>Quanto mais câmeras simultâneas, maior o esforço do computador e da rede. Se a operação ficar lenta, reduza a quantidade de imagens abertas ou use a qualidade mais leve quando disponível.</p></section>
              <section class="doc-section"><h2>Controles da câmera</h2><div class="feature-grid"><div class="feature-card"><h3>Qualidade da imagem</h3><p>Escolha entre maior definição e menor consumo, conforme a necessidade da operação.</p></div><div class="feature-card"><h3>Áudio</h3><p>Ativa o som apenas quando a câmera e a sua permissão oferecem esse recurso.</p></div><div class="feature-card"><h3>Captura</h3><p>Salva uma imagem do momento atual, respeitando as regras da instalação.</p></div><div class="feature-card"><h3>Trecho rápido</h3><p>Permite registrar um pequeno período em torno de uma ocorrência, quando habilitado.</p></div><div class="feature-card"><h3>Controle PTZ</h3><p>Abre os movimentos e o zoom de câmeras compatíveis.</p></div><div class="feature-card"><h3>Tela cheia</h3><p>Amplia a visualização e reduz distrações durante o acompanhamento.</p></div></div></section>
              <section class="doc-section"><h2>Indicadores sobre a imagem</h2><p>A tela pode mostrar o nome da câmera, situação da conexão, qualidade e quantidade aproximada de quadros por segundo. Um valor muito baixo, imagem piscando ou reconexões frequentes indicam instabilidade e devem ser investigados.</p>${callout("info", "Movimento não é reconhecimento de objeto", "Uma indicação de movimento informa mudança relevante na cena. Caixas com nomes de pessoas, veículos ou outros objetos pertencem a recursos de análise avançada e só devem aparecer quando esse recurso estiver habilitado para a câmera.")}</section>
              <section class="doc-section"><h2>Quando a imagem demora ou reinicia</h2><ol><li>Espere uma tentativa completa de conexão, sem atualizar repetidamente a página.</li><li>Confira se outras câmeras apresentam o mesmo comportamento.</li><li>Teste uma grade menor.</li><li>Registre nome da câmera, horário, duração e se ocorreu em mais de um computador.</li><li>Se persistir, consulte <a href="#problemas-frequentes">Problemas frequentes</a> e encaminhe as informações ao suporte.</li></ol>${callout("warning", "Não altere a câmera durante uma ocorrência", "Mudanças de conexão ou gravação podem apagar pistas do problema e interromper a captura. Prefira registrar o comportamento primeiro.")}</section>`
          },
          {
            id: "modo-mural",
            title: "Modo Mural",
            summary: "Monte uma visão contínua para televisores e salas de monitoramento.",
            roles: ["Visualizador", "Operador", "Administrador"],
            time: "4 min",
            keywords: "wall mural tv monitor grade 2x2 3x3 4x4 tela cheia",
            related: ["ao-vivo", "status-e-indicadores"],
            body: `
              <section class="doc-section"><h2>Quando usar</h2><p>O <strong>Modo Mural</strong> foi pensado para telas que permanecem abertas durante a operação, como televisores de portaria e monitores de uma central local. Ele prioriza o espaço das imagens e reduz elementos de navegação.</p></section>
              <section class="doc-section"><h2>Escolher o formato</h2><p>Os formatos disponíveis podem incluir 2 × 2, 2 × 3, 3 × 3 e 4 × 4. Escolha a menor grade que comporte as câmeras essenciais: imagens maiores facilitam a identificação de detalhes e consomem menos recursos.</p></section>
              <section class="doc-section"><h2>Boas práticas</h2><ul><li>Agrupe câmeras por local, prioridade ou rota de vigilância.</li><li>Não use o mural como garantia de que uma câmera está gravando; ele mostra a visualização atual.</li><li>Evite deixar câmeras sem uso ocupando posições.</li><li>Em televisores, desative modos de economia que desliguem a tela durante o turno.</li></ul></section>`
          },
          {
            id: "reproducao",
            title: "Reprodução de gravações",
            summary: "Localize momentos no histórico, navegue pela linha do tempo e baixe trechos autorizados.",
            roles: ["Visualizador autorizado", "Operador", "Administrador"],
            time: "9 min",
            keywords: "playback reprodução gravação histórico linha tempo data baixar download exportar zip h265 stream 1 stream 2",
            related: ["revisao", "downloads-e-evidencias", "armazenamento", "investigacoes"],
            body: `
              <section class="doc-section"><h2>Localizar uma gravação</h2><ol class="steps"><li>Abra <strong>Reprodução</strong>.</li><li>Selecione a câmera desejada.</li><li>Escolha a data e o intervalo aproximado.</li><li>Use a linha do tempo para encontrar o ponto exato.</li><li>Reproduza e ajuste a velocidade conforme a necessidade.</li></ol>${callout("info", "Horário da ocorrência", "Confirme o horário informado e a referência usada pela instalação. Uma diferença de poucos minutos pode levar à análise do trecho errado.")}</section>
              <section class="doc-section"><h2>Entender a linha do tempo</h2><p>Faixas preenchidas indicam períodos com gravação disponível. Espaços vazios podem significar que não houve gravação, que o arquivo ainda está sendo finalizado, que a retenção já o removeu ou que ocorreu uma falha.</p><p>Use os controles de play e pausa, saltos curtos e longos e velocidade para avançar. A comparação entre câmeras ajuda a seguir uma pessoa ou evento entre áreas diferentes.</p></section>
              <section class="doc-section"><h2>Qualidade e compatibilidade</h2><p>Algumas câmeras oferecem uma imagem principal de maior qualidade e outra mais leve. O sistema escolhe a opção apropriada para visualização e gravação conforme a configuração. Formatos de imagem mais eficientes podem exigir um equipamento ou navegador compatível.</p>${callout("warning", "Não mude a configuração para abrir uma gravação", "Se um trecho não reproduzir, preserve o arquivo e comunique o suporte. Alterar a câmera não recupera material já gravado e pode afetar as gravações seguintes.")}</section>
              <section class="doc-section"><h2>Baixar ou exportar</h2><p>Quando sua função permite, selecione o início e o fim do trecho e informe o motivo. Para várias câmeras, a exportação pode preparar um pacote com os arquivos correspondentes.</p><ul><li>Baixe somente o período necessário.</li><li>Não feche a tela durante a preparação.</li><li>Confira o arquivo após o download.</li><li>Guarde-o no local definido pela empresa.</li><li>Registre para quem ele foi entregue.</li></ul></section>
              <section class="doc-section"><h2>Se o histórico estiver bloqueado</h2><p>Uma instalação ou grupo em situação <strong>Restrita</strong> pode manter o Ao Vivo e bloquear o histórico. A interface não deve ser usada para contornar essa regra. Procure um administrador autorizado para confirmar a situação.</p></section>`
          },
          {
            id: "revisao",
            title: "Revisão de eventos",
            summary: "Encontre rapidamente momentos com movimento ou objetos e marque o que já foi analisado.",
            roles: ["Visualizador autorizado", "Operador", "Administrador"],
            time: "6 min",
            keywords: "review revisão evento movimento objeto confirmado visto não visto filtro câmera",
            related: ["reproducao", "movimento-e-analises", "alertas"],
            body: `
              <section class="doc-section"><h2>Para que serve</h2><p>A tela <strong>Revisão</strong> reduz o tempo gasto procurando acontecimentos. Ela lista momentos identificados pelo sistema e permite abrir diretamente o ponto correspondente na Reprodução.</p></section>
              <section class="doc-section"><h2>Usar os filtros</h2><div class="feature-grid"><div class="feature-card"><h3>Câmera</h3><p>Limita a busca a um local específico.</p></div><div class="feature-card"><h3>Tipo</h3><p>Filtra movimento ou categorias disponíveis para a instalação.</p></div><div class="feature-card"><h3>Confirmados</h3><p>Mostra somente resultados que atendem ao critério definido.</p></div><div class="feature-card"><h3>Não vistos</h3><p>Destaca o que ainda precisa ser analisado por um operador.</p></div></div></section>
              <section class="doc-section"><h2>Fluxo recomendado</h2><ol class="steps"><li>Defina câmera e período.</li><li>Analise a miniatura e o tipo indicado.</li><li>Abra o evento na Reprodução para confirmar o contexto completo.</li><li>Marque como visto somente depois da análise.</li><li>Se houver relevância, encaminhe para um alerta ou investigação conforme o procedimento local.</li></ol>${callout("warning", "Resultados automáticos precisam de confirmação humana", "Luz, sombra, chuva, insetos e mudanças na cena podem ser interpretados como movimento. Nunca tome uma decisão importante apenas pela etiqueta automática.")}</section>`
          },
          {
            id: "ptz",
            title: "Controle PTZ",
            summary: "Movimente câmeras compatíveis, aplique zoom e use posições salvas com responsabilidade.",
            roles: ["Operador autorizado", "Administrador"],
            time: "5 min",
            keywords: "ptz movimentar câmera zoom preset posição patrulha foco",
            related: ["ao-vivo", "cameras"],
            body: `
              <section class="doc-section"><h2>O que é PTZ</h2><p>PTZ é o controle de câmeras capazes de girar, inclinar e aproximar a imagem. O recurso só aparece para equipamentos compatíveis e contas autorizadas.</p></section>
              <section class="doc-section"><h2>Operação básica</h2><ol class="steps"><li>Selecione a câmera.</li><li>Use as setas com toques curtos para ajustar a direção.</li><li>Aplique zoom de forma gradual.</li><li>Se existirem posições salvas, escolha a posição desejada.</li><li>Ao terminar, retorne à posição padrão definida pela instalação.</li></ol></section>
              <section class="doc-section"><h2>Cuidados</h2><ul><li>Duas pessoas tentando controlar a mesma câmera podem gerar movimentos inesperados.</li><li>Ao mover a câmera, a área anterior deixa de ser observada.</li><li>Não altere posições salvas sem autorização.</li><li>Evite movimentos contínuos desnecessários.</li></ul>${callout("danger", "Área crítica fora do enquadramento", "Antes de mover uma câmera usada para entrada, caixa ou acesso restrito, confirme se outra câmera mantém a cobertura do local.")}</section>`
          }
        ]
      },
      {
        id: "operacao",
        title: "Operação diária",
        icon: "activity",
        articles: [
          {
            id: "alertas",
            title: "Alertas e ocorrências",
            summary: "Entenda prioridades, reconheça um alerta e registre sua resolução.",
            roles: ["Operador", "Administrador"],
            time: "7 min",
            keywords: "alarme alerta ocorrência ativo reconhecer resolver som prioridade regra notificação",
            related: ["revisao", "investigacoes", "movimento-e-analises"],
            body: `
              <section class="doc-section"><h2>Estados de um alerta</h2><div class="status-list"><div class="status-row"><span class="status-label"><i class="status-dot red"></i>Ativo</span><p>O evento ainda precisa ser verificado.</p></div><div class="status-row"><span class="status-label"><i class="status-dot amber"></i>Reconhecido</span><p>Um operador assumiu a análise, mas o atendimento ainda não terminou.</p></div><div class="status-row"><span class="status-label"><i class="status-dot green"></i>Resolvido</span><p>A verificação foi concluída e o resultado foi registrado.</p></div></div></section>
              <section class="doc-section"><h2>Fluxo de atendimento</h2><ol class="steps"><li>Leia câmera, horário, tipo e prioridade.</li><li>Abra a imagem e consulte o momento relacionado.</li><li>Reconheça o alerta para informar à equipe que ele está em atendimento.</li><li>Siga o procedimento da instalação: contato, deslocamento, acionamento ou simples observação.</li><li>Registre uma descrição objetiva e marque como resolvido somente ao final.</li></ol></section>
              <section class="doc-section"><h2>Som e notificações</h2><p>O som chama a atenção para novos eventos, mas não substitui a observação da lista. Se o navegador bloquear áudio, pode ser necessário interagir com a página antes que ele seja reproduzido.</p></section>
              <section class="doc-section"><h2>Regras de alerta</h2><p>Administradores podem ajustar quando certos alertas são gerados. Alterações mal planejadas podem produzir alertas excessivos ou deixar situações sem aviso. Antes de mudar uma regra, documente objetivo, horário, câmeras e responsável por validar o resultado.</p>${callout("warning", "Não confunda reconhecer com resolver", "Reconhecer significa assumir o atendimento. Resolver significa que a situação foi verificada e encerrada.")}</section>`
          },
          {
            id: "cameras",
            title: "Câmeras e situação operacional",
            summary: "Consulte câmeras, entenda seus estados e saiba quais ações são seguras para cada perfil.",
            roles: ["Operador autorizado", "Administrador"],
            time: "8 min",
            keywords: "câmera adicionar editar online offline reconectar gravação movimento manual contínua agenda status",
            related: ["ao-vivo", "ptz", "armazenamento", "problemas-frequentes"],
            body: `
              <section class="doc-section"><h2>Lista de câmeras</h2><p>A área <strong>Câmeras</strong> reúne o nome, local, situação e recursos disponíveis em cada equipamento. Use nomes claros, como “Entrada principal — lado externo”, para reduzir erros durante ocorrências.</p></section>
              <section class="doc-section"><h2>Estados comuns</h2><div class="status-list"><div class="status-row"><span class="status-label"><i class="status-dot green"></i>Conectada</span><p>A câmera está respondendo e pode fornecer imagem.</p></div><div class="status-row"><span class="status-label"><i class="status-dot amber"></i>Conectando</span><p>O sistema está tentando iniciar ou restabelecer a imagem.</p></div><div class="status-row"><span class="status-label"><i class="status-dot red"></i>Desconectada</span><p>A câmera não está fornecendo imagem; verifique o período e se outras câmeras foram afetadas.</p></div><div class="status-row"><span class="status-label"><i class="status-dot blue"></i>Gravando</span><p>Há uma sessão de gravação em andamento conforme o modo configurado.</p></div></div></section>
              <section class="doc-section"><h2>Modos de gravação</h2><div class="feature-grid"><div class="feature-card"><h3>Contínua</h3><p>Grava de forma permanente enquanto a câmera e o armazenamento estiverem disponíveis.</p></div><div class="feature-card"><h3>Por movimento</h3><p>Grava quando há mudança relevante na cena, com regras próprias da instalação.</p></div><div class="feature-card"><h3>Por agenda</h3><p>Grava em dias e horários definidos.</p></div><div class="feature-card"><h3>Manual</h3><p>Um usuário autorizado inicia e encerra a gravação quando necessário.</p></div></div></section>
              <section class="doc-section"><h2>Ações operacionais</h2><p>Dependendo da sua permissão, você pode iniciar uma gravação manual, ativar o monitoramento de movimento ou solicitar uma reconexão. Aguarde o resultado antes de repetir a ação.</p>${callout("danger", "Configurações especializadas", "Endereço, credenciais, formato da imagem, agenda de gravação e conexão devem ser alterados somente por administrador treinado ou suporte. Uma mudança incorreta pode interromper imagens e gravações.")}</section>
              <section class="doc-section"><h2>Ao cadastrar ou substituir uma câmera</h2><ul><li>Defina nome e localização sem ambiguidade.</li><li>Confirme data e hora do equipamento.</li><li>Valide imagem ao vivo e gravação.</li><li>Teste retorno após uma interrupção controlada.</li><li>Confirme acesso dos grupos corretos.</li><li>Registre quem realizou e aprovou a mudança.</li></ul></section>`
          },
          {
            id: "investigacoes",
            title: "Investigações",
            summary: "Organize uma apuração com câmeras, período, participantes, notas e evidências.",
            roles: ["Operador autorizado", "Administrador"],
            time: "8 min",
            keywords: "investigação caso ocorrência evidência nota participante câmera período relatório custódia preservar",
            related: ["downloads-e-evidencias", "reproducao", "alertas"],
            body: `
              <section class="doc-section"><h2>Quando criar uma investigação</h2><p>Use uma investigação quando uma ocorrência exigir análise organizada, participação de mais pessoas, preservação de material ou produção de relatório. Para consultas rápidas sem consequência, a Reprodução pode ser suficiente.</p></section>
              <section class="doc-section"><h2>Informações principais</h2><div class="feature-grid"><div class="feature-card"><h3>Identificação</h3><p>Título claro, situação, prioridade e classificação.</p></div><div class="feature-card"><h3>Responsáveis</h3><p>Proprietário do caso e participantes autorizados.</p></div><div class="feature-card"><h3>Escopo</h3><p>Câmeras e período exato que serão analisados.</p></div><div class="feature-card"><h3>Registro</h3><p>Notas, atividades, evidências e relatório final.</p></div></div></section>
              <section class="doc-section"><h2>Fluxo recomendado</h2><ol class="steps"><li>Crie o caso com título que não exponha dados desnecessários.</li><li>Defina período, câmeras e responsáveis.</li><li>Analise a linha do tempo e registre fatos em ordem.</li><li>Adicione somente evidências relevantes.</li><li>Preserve o material quando houver exigência legal ou interna.</li><li>Revise participantes e finalize o relatório.</li></ol></section>
              <section class="doc-section"><h2>Preservação e histórico</h2><p>A opção de preservação impede que material importante siga a rotina normal de descarte, quando esse recurso estiver habilitado. Use-a somente para casos justificados e com prazo ou responsável definidos.</p>${callout("danger", "Evidência não deve ser editada", "Mantenha o arquivo original preservado. Se for necessário destacar ou converter algo, guarde a versão derivada separadamente e registre o motivo.")}</section>`
          },
          {
            id: "downloads-e-evidencias",
            title: "Downloads, exportações e evidências",
            summary: "Cuidados para obter, conferir, guardar e compartilhar imagens de forma responsável.",
            roles: ["Usuários autorizados"],
            time: "6 min",
            keywords: "download baixar exportar evidência mp4 zip imagem compartilhar cadeia custódia",
            related: ["reproducao", "investigacoes", "acesso-e-privacidade"],
            body: `
              <section class="doc-section"><h2>Antes de baixar</h2><p>Confirme que sua função permite a exportação e que existe motivo legítimo. Escolha somente as câmeras e o período necessários para reduzir exposição de pessoas sem relação com a ocorrência.</p></section>
              <section class="doc-section"><h2>Depois do download</h2><ol class="steps"><li>Confira se o arquivo abre e contém o início e o fim esperados.</li><li>Mantenha o original sem cortes.</li><li>Use nome ou identificação prevista no procedimento da empresa.</li><li>Guarde em local de acesso controlado.</li><li>Registre data, responsável, motivo e destinatário do compartilhamento.</li></ol></section>
              <section class="doc-section"><h2>Compartilhamento</h2><p>Evite aplicativos pessoais, grupos de mensagens e armazenamento particular. Quando uma autoridade ou terceiro solicitar imagens, siga a aprovação e o canal formal da empresa.</p>${callout("warning", "Download não é cópia de segurança", "Um arquivo baixado para análise não substitui a política de backup e retenção da instalação.")}</section>`
          },
          {
            id: "movimento-e-analises",
            title: "Movimento e análises de imagem",
            summary: "Diferença entre detecção de movimento e identificação avançada de objetos.",
            roles: ["Operador", "Administrador"],
            time: "6 min",
            keywords: "movimento mog2 ia yolo pessoa veículo objeto caixa quadrado percentual zona falso positivo",
            related: ["revisao", "alertas", "ao-vivo", "cameras"],
            body: `
              <section class="doc-section"><h2>Detecção de movimento</h2><p>A detecção de movimento observa mudanças entre imagens consecutivas. Ela é útil para apontar atividade em uma cena, mas não entende sozinha se o que mudou foi uma pessoa, sombra, chuva, árvore ou farol.</p></section>
              <section class="doc-section"><h2>Análise avançada de objetos</h2><p>Recursos avançados tentam classificar elementos como pessoa ou veículo e podem desenhar caixas com nome e percentual sobre a imagem. Isso é diferente da detecção simples de movimento.</p><div class="table-wrap"><table><thead><tr><th>Recurso</th><th>O que informa</th><th>O que pode aparecer</th></tr></thead><tbody><tr><td>Movimento</td><td>Houve mudança relevante na cena</td><td>Indicador ou evento de movimento</td></tr><tr><td>Análise de objetos</td><td>Provável categoria do elemento encontrado</td><td>Caixa, nome do objeto e nível de confiança</td></tr></tbody></table></div>${callout("warning", "Se caixas aparecerem com a análise desativada", "Registre câmera, horário e uma captura sem expor pessoas desnecessariamente. Não altere a configuração durante o teste; encaminhe ao administrador ou suporte para confirmar a origem da sobreposição.")}</section>
              <section class="doc-section"><h2>Zonas e sensibilidade</h2><p>Zonas limitam a região observada, e a sensibilidade determina quanta mudança é necessária para gerar um evento. Ajustes excessivos podem aumentar falsos alertas; ajustes baixos podem ignorar atividade importante.</p></section>
              <section class="doc-section"><h2>Validação humana</h2><p>Percentuais e nomes são estimativas, não garantias. Confirme o vídeo completo, o contexto e outras câmeras antes de tomar uma decisão.</p></section>`
          }
        ]
      },
      {
        id: "gravacoes",
        title: "Gravações e capacidade",
        icon: "database",
        articles: [
          {
            id: "armazenamento",
            title: "Armazenamento e retenção",
            summary: "Acompanhe o espaço de gravações, entenda a retenção e dimensione o disco.",
            roles: ["Operador autorizado", "Administrador", "Gestor"],
            time: "7 min",
            keywords: "storage armazenamento disco volume retenção espaço uso câmera saúde servidor nuvem dimensionamento",
            related: ["reproducao", "cameras", "problemas-frequentes"],
            body: `
              <section class="doc-section"><h2>O que a tela mostra</h2><p>A área <strong>Armazenamento</strong> ajuda a entender se a instalação possui espaço suficiente para gravar pelo período esperado.</p><div class="feature-grid"><div class="feature-card"><h3>Saúde da instalação</h3><p>Visão geral de uso do equipamento, memória, disco e quantidade de transmissões.</p></div><div class="feature-card"><h3>Volumes</h3><p>Locais onde as gravações são armazenadas e quanto espaço ainda existe.</p></div><div class="feature-card"><h3>Uso por câmera</h3><p>Estimativa do espaço consumido por cada câmera.</p></div><div class="feature-card"><h3>Armazenamento adicional</h3><p>Destino complementar, quando contratado e configurado.</p></div></div></section>
              <section class="doc-section"><h2>O que é retenção</h2><p>Retenção é o período pelo qual as gravações permanecem disponíveis. Quando o limite de tempo ou espaço é atingido, materiais antigos podem ser removidos conforme a política definida.</p>${callout("danger", "Disco cheio pode interromper gravações", "Não espere o espaço chegar ao limite. Investigue crescimento inesperado e confirme que a remoção automática está funcionando.")}</section>
              <section class="doc-section"><h2>Dimensionar corretamente</h2><p>O consumo depende de quantidade de câmeras, qualidade, quadros por segundo, complexidade da cena, horas gravadas por dia e dias de retenção. Use o guia completo para simular cenários:</p><p><a href="/armazenamento/"><strong>Abrir o Guia de Armazenamento de Gravações →</strong></a></p></section>
              <section class="doc-section"><h2>Rotina recomendada</h2><ul><li>Verifique o espaço disponível em uma frequência definida.</li><li>Compare o uso atual com semanas anteriores.</li><li>Investigue uma câmera que consome muito mais que as demais.</li><li>Confirme amostras antigas e recentes na Reprodução.</li><li>Antes de aumentar qualidade ou retenção, recalcule a capacidade.</li></ul></section>`
          },
          {
            id: "continuidade-das-gravacoes",
            title: "Continuidade e falhas de gravação",
            summary: "Como reconhecer lacunas, preservar informações e agir sem agravar uma falha.",
            roles: ["Operador", "Administrador", "Gestor"],
            time: "6 min",
            keywords: "gravação falha lacuna disco cheio arquivo reinício energia indisponível retenção",
            related: ["armazenamento", "reproducao", "problemas-frequentes"],
            body: `
              <section class="doc-section"><h2>Sinais de atenção</h2><ul><li>Faixas vazias inesperadas na linha do tempo.</li><li>Câmera ao vivo sem gravação correspondente.</li><li>Espaço disponível caindo de forma anormal.</li><li>Arquivo que não abre ou termina antes do horário esperado.</li><li>Várias câmeras interrompidas no mesmo instante.</li></ul></section>
              <section class="doc-section"><h2>Como agir</h2><ol class="steps"><li>Registre câmera, intervalo e horário em que o problema foi observado.</li><li>Confira se afeta uma câmera ou várias.</li><li>Evite reiniciar equipamentos ou alterar retenção por conta própria.</li><li>Preserve gravações relacionadas que ainda estejam acessíveis.</li><li>Encaminhe ao suporte com a sequência dos fatos.</li></ol>${callout("warning", "Uma imagem ao vivo não prova que existe gravação", "Acompanhe também o estado da gravação e faça verificações periódicas de trechos recentes.")}</section>
              <section class="doc-section"><h2>Após queda de energia</h2><p>Confirme o retorno das câmeras, aguarde a finalização das conexões e valide uma gravação curta de cada grupo prioritário. Se houver lacunas, registre o período antes de qualquer manutenção.</p></section>`
          }
        ]
      },
      {
        id: "administracao",
        title: "Administração",
        icon: "users",
        articles: [
          {
            id: "usuarios",
            title: "Usuários",
            summary: "Crie, revise, bloqueie e remova acessos de forma responsável.",
            roles: ["Administradores"],
            time: "7 min",
            keywords: "usuário criar editar bloquear excluir senha acesso pessoa operador visualizador administrador",
            related: ["grupos", "funcoes", "acesso-e-privacidade"],
            body: `
              <section class="doc-section"><h2>Antes de criar um usuário</h2><p>Confirme identidade, função na empresa, câmeras necessárias, data de início e responsável pela autorização. Cada pessoa deve ter uma conta individual.</p></section>
              <section class="doc-section"><h2>Cadastro seguro</h2><ol class="steps"><li>Informe nome e contato corporativo corretos.</li><li>Associe a função com as ações necessárias.</li><li>Associe o grupo com as câmeras corretas.</li><li>Defina uma credencial inicial conforme o procedimento da empresa.</li><li>Peça que a pessoa revise seu acesso no primeiro uso.</li></ol></section>
              <section class="doc-section"><h2>Quando o vínculo muda</h2><div class="table-wrap"><table><thead><tr><th>Situação</th><th>Ação recomendada</th></tr></thead><tbody><tr><td>Mudança de área</td><td>Revisar função, grupo e câmeras no mesmo dia.</td></tr><tr><td>Afastamento temporário</td><td>Bloquear conforme a política e registrar o motivo.</td></tr><tr><td>Desligamento</td><td>Revogar o acesso imediatamente e preservar o histórico.</td></tr><tr><td>Dispositivo perdido</td><td>Trocar credencial, encerrar acessos e comunicar o responsável.</td></tr></tbody></table></div></section>
              <section class="doc-section"><h2>Revisão periódica</h2><p>Revise contas inativas, administradores, prestadores e acessos temporários. Remova permissões que não tenham mais justificativa.</p>${callout("danger", "Não reutilize contas", "Quando uma pessoa sai, desative sua conta e crie outra para o substituto. Renomear uma conta antiga compromete o histórico de responsabilidades.")}</section>`
          },
          {
            id: "grupos",
            title: "Grupos de acesso",
            summary: "Organize pessoas e câmeras por área, cliente, unidade ou responsabilidade.",
            roles: ["Administradores"],
            time: "5 min",
            keywords: "grupo câmera pessoa unidade área restrito histórico suspenso",
            related: ["usuarios", "funcoes", "perfis-e-permissoes"],
            body: `
              <section class="doc-section"><h2>Para que servem</h2><p>Grupos evitam liberar câmeras uma a uma para cada pessoa. Eles representam um conjunto coerente, como uma filial, condomínio, setor ou equipe.</p></section>
              <section class="doc-section"><h2>Planejamento recomendado</h2><ul><li>Use nomes compreensíveis fora da equipe técnica.</li><li>Não misture áreas com responsáveis diferentes.</li><li>Evite grupos excessivamente amplos por conveniência.</li><li>Revise o grupo sempre que uma câmera mudar de local.</li></ul></section>
              <section class="doc-section"><h2>Restringir ou suspender</h2><p><strong>Restrito</strong> pode manter o acompanhamento atual e retirar o acesso ao histórico. <strong>Suspenso</strong> interrompe o acesso. Antes de alterar a situação, confirme a regra comercial e operacional aplicável, comunique os responsáveis e registre a decisão.</p></section>`
          },
          {
            id: "funcoes",
            title: "Funções e permissões",
            summary: "Monte perfis adequados às responsabilidades sem liberar administração desnecessária.",
            roles: ["Administradores"],
            time: "6 min",
            keywords: "role função permissão visualizar live playback ptz alarme exportar evidência configurar servidor relatório",
            related: ["usuarios", "grupos", "perfis-e-permissoes"],
            body: `
              <section class="doc-section"><h2>O que uma função pode controlar</h2><p>Entre as permissões disponíveis podem estar: ver Ao Vivo, consultar Reprodução, controlar PTZ, tratar alertas, configurar câmeras, gerenciar usuários, consultar histórico de ações, exportar evidências, administrar a instalação e emitir relatórios.</p></section>
              <section class="doc-section"><h2>Criar um perfil sob medida</h2><ol class="steps"><li>Liste as atividades reais do cargo.</li><li>Marque somente as permissões necessárias.</li><li>Associe um grupo limitado de câmeras.</li><li>Teste com uma conta sem privilégios administrativos.</li><li>Peça ao responsável da área para validar o resultado.</li></ol></section>
              <section class="doc-section"><h2>Combinações sensíveis</h2><p>Exportar evidências, administrar usuários, alterar câmeras e configurar a instalação têm impacto elevado. Essas permissões devem ficar separadas quando as responsabilidades da empresa exigirem aprovação por mais de uma pessoa.</p>${callout("info", "Prefira função personalizada", "Se alguém precisa de apenas uma ação adicional, crie ou ajuste um perfil específico em vez de torná-lo administrador.")}</section>`
          },
          {
            id: "configuracoes",
            title: "Configurações da instalação",
            summary: "Entenda as áreas de configuração e quais mudanças exigem planejamento.",
            roles: ["Administradores"],
            time: "8 min",
            keywords: "settings configuração geral aparência logo cor retenção disco segurança senha sessão gpu desempenho",
            related: ["armazenamento", "usuarios", "acesso-e-privacidade"],
            body: `
              <section class="doc-section"><h2>Áreas disponíveis</h2><div class="feature-grid"><div class="feature-card"><h3>Geral</h3><p>Identificação e preferências básicas da instalação.</p></div><div class="feature-card"><h3>Aparência</h3><p>Logo e cores apresentadas nos ambientes liberados.</p></div><div class="feature-card"><h3>Retenção e disco</h3><p>Regras de tempo e espaço para as gravações.</p></div><div class="feature-card"><h3>Segurança</h3><p>Políticas de senha e duração da sessão.</p></div><div class="feature-card"><h3>Desempenho</h3><p>Uso de recursos especiais do equipamento, quando disponíveis.</p></div><div class="feature-card"><h3>Usuários</h3><p>Atalho para a gestão de contas e acessos.</p></div></div></section>
              <section class="doc-section"><h2>Antes de salvar uma mudança</h2><ol class="steps"><li>Registre o valor atual.</li><li>Defina objetivo e resultado esperado.</li><li>Calcule o impacto em armazenamento e operação.</li><li>Escolha um horário seguro.</li><li>Valide Ao Vivo, Reprodução e alertas após a mudança.</li><li>Se o resultado piorar, retorne ao valor anterior aprovado.</li></ol></section>
              <section class="doc-section"><h2>Configurações que exigem suporte</h2><p>Aceleração por placa gráfica, formatos de imagem, caminhos de armazenamento e parâmetros avançados dependem do equipamento instalado. Mantenha o padrão aprovado e peça validação técnica antes de alterar.</p>${callout("danger", "Retenção pode remover gravações", "Reduzir períodos ou espaço reservado pode antecipar a exclusão de material. Confirme a política da empresa e preserve casos importantes antes da mudança.")}</section>`
          },
          {
            id: "acesso-e-privacidade",
            title: "Privacidade e uso responsável",
            summary: "Princípios para proteger pessoas, imagens, credenciais e histórico de ações.",
            roles: ["Todos os perfis"],
            time: "5 min",
            keywords: "privacidade lgpd segurança senha compartilhar gravação dado pessoal auditoria",
            related: ["minha-conta", "downloads-e-evidencias", "usuarios"],
            body: `
              <section class="doc-section"><h2>Imagens são informações protegidas</h2><p>Gravações podem identificar pessoas, rotinas e áreas sensíveis. A visualização deve ter finalidade de segurança ou operação autorizada e seguir as políticas da empresa e a legislação aplicável.</p></section>
              <section class="doc-section"><h2>Práticas essenciais</h2><ul><li>Não fotografe a tela com celular pessoal.</li><li>Não compartilhe imagens por canais informais.</li><li>Não deixe uma sessão aberta sem supervisão.</li><li>Não procure pessoas ou eventos por curiosidade.</li><li>Informe imediatamente perda de dispositivo ou suspeita de acesso indevido.</li><li>Mantenha comentários objetivos e respeitosos.</li></ul></section>
              <section class="doc-section"><h2>Histórico de ações</h2><p>Operações relevantes podem ser registradas para controle e apuração. Por isso, cada pessoa deve usar sua própria conta e os administradores devem manter os dados dos usuários atualizados.</p></section>`
          }
        ]
      },
      {
        id: "aplicativo",
        title: "Aplicativo móvel",
        icon: "phone",
        articles: [
          {
            id: "aplicativo-movel",
            title: "AjustCam no celular",
            summary: "Use os recursos móveis com segurança dentro e fora da instalação.",
            roles: ["Usuários autorizados"],
            time: "6 min",
            keywords: "mobile celular aplicativo notificações ao vivo playback baixar compartilhar offline biometria",
            related: ["ao-vivo", "reproducao", "acesso-e-privacidade"],
            body: `
              <section class="doc-section"><h2>O que pode estar disponível</h2><p>Conforme sua permissão, o aplicativo permite entrar na instalação, visualizar câmeras, consultar gravações, receber notificações e compartilhar arquivos autorizados.</p></section>
              <section class="doc-section"><h2>Uso seguro</h2><ul><li>Proteja o celular com senha ou biometria.</li><li>Instale somente a versão indicada pela empresa.</li><li>Evite redes públicas desconhecidas.</li><li>Não salve imagens no aparelho além do necessário.</li><li>Ao trocar ou perder o celular, comunique imediatamente o administrador.</li></ul></section>
              <section class="doc-section"><h2>Imagens e arquivos temporários</h2><p>Um vídeo baixado ou compartilhado pode permanecer no aparelho ou em outro aplicativo. Depois da utilização autorizada, remova as cópias conforme a política da empresa e verifique a pasta de downloads.</p></section>
              <section class="doc-section"><h2>Sem conexão</h2><p>Se o celular ficar sem internet, informações exibidas anteriormente podem estar desatualizadas. Aguarde a reconexão antes de confirmar a situação de uma câmera ou alerta.</p>${callout("warning", "Notificação não substitui acompanhamento", "A entrega de notificações depende do aparelho, conexão e configurações do sistema operacional. Ocorrências críticas precisam de um procedimento complementar.")}</section>`
          }
        ]
      },
      {
        id: "suporte",
        title: "Ajuda e diagnóstico",
        icon: "help",
        articles: [
          {
            id: "status-e-indicadores",
            title: "Status e indicadores da tela",
            summary: "Aprenda a interpretar conexão, gravação, movimento, quadros e mensagens.",
            roles: ["Todos os perfis"],
            time: "5 min",
            keywords: "status indicador online offline fps 0 fps gravando movimento carregando erro",
            related: ["ao-vivo", "cameras", "problemas-frequentes"],
            body: `
              <section class="doc-section"><h2>Indicadores principais</h2><div class="table-wrap"><table><thead><tr><th>Indicador</th><th>Significado prático</th></tr></thead><tbody><tr><td>Conectada</td><td>A câmera está respondendo ao sistema.</td></tr><tr><td>Gravando</td><td>Existe uma gravação em andamento para a câmera.</td></tr><tr><td>Conectando</td><td>A imagem ainda está sendo iniciada ou restabelecida.</td></tr><tr><td>Sem sinal</td><td>A câmera não forneceu imagem naquele momento.</td></tr><tr><td>Quadros por segundo</td><td>Ritmo aproximado de atualização da imagem. Valor baixo pode causar travamentos visuais.</td></tr><tr><td>Movimento</td><td>O sistema percebeu mudança relevante na cena.</td></tr></tbody></table></div></section>
              <section class="doc-section"><h2>Indicador momentâneo ou problema?</h2><p>Uma oscilação curta pode ocorrer durante a abertura da imagem. Considere problema quando o comportamento dura, se repete, afeta gravações ou acontece em várias câmeras.</p></section>
              <section class="doc-section"><h2>O que registrar</h2><ul><li>Data e horário exatos.</li><li>Nome das câmeras afetadas.</li><li>Texto da mensagem, sem incluir senhas.</li><li>Duração e frequência.</li><li>Se Ao Vivo e Reprodução foram afetados.</li><li>Se ocorreu em outro computador ou celular.</li></ul></section>`
          },
          {
            id: "problemas-frequentes",
            title: "Problemas frequentes",
            summary: "Verificações seguras para imagem lenta, câmera offline, histórico vazio e acesso negado.",
            roles: ["Todos os perfis"],
            time: "8 min",
            keywords: "problema erro lento demora 30 segundos pisca reinicia fps zero câmera offline playback vazio acesso negado",
            related: ["ao-vivo", "reproducao", "continuidade-das-gravacoes", "status-e-indicadores"],
            body: `
              <section class="doc-section"><h2>A imagem ao vivo demora para abrir</h2><ol><li>Aguarde a tentativa atual sem atualizar a página várias vezes.</li><li>Abra menos câmeras simultaneamente.</li><li>Confira se o problema ocorre em uma câmera ou em todas.</li><li>Teste outro dispositivo na mesma rede, se permitido.</li><li>Registre o tempo aproximado até a imagem aparecer.</li></ol></section>
              <section class="doc-section"><h2>A imagem pisca, reinicia ou fica com poucos quadros</h2><p>Isso pode estar relacionado à câmera, rede, capacidade do equipamento ou recuperação automática da transmissão. Registre se o áudio e a gravação também foram afetados. Não altere qualidade ou conexão durante a coleta inicial.</p></section>
              <section class="doc-section"><h2>A câmera aparece offline</h2><ol><li>Confira se o local está com energia e rede, sem desligar nada.</li><li>Veja se câmeras próximas também estão offline.</li><li>Anote quando a última imagem foi vista.</li><li>Se você tiver permissão, faça apenas uma solicitação de reconexão e aguarde.</li><li>Acione o suporte se não retornar.</li></ol></section>
              <section class="doc-section"><h2>Não há gravação no período</h2><p>Limpe filtros, confirme câmera, data e horário. Verifique a situação do grupo, a retenção e o estado da gravação. Uma lacuna inesperada deve ser tratada como ocorrência operacional.</p></section>
              <section class="doc-section"><h2>Uma opção não aparece ou o acesso foi negado</h2><p>Saia e entre novamente uma vez. Se persistir, peça ao administrador para confirmar sua função, grupo e câmeras — sem compartilhar sua senha.</p>${callout("danger", "Não tente corrigir reiniciando tudo", "Reinícios e mudanças simultâneas podem interromper gravações e apagar sinais úteis ao diagnóstico. Registre primeiro e altere somente com um plano autorizado.")}</section>`
          },
          {
            id: "perguntas-frequentes",
            title: "Perguntas frequentes",
            summary: "Respostas diretas às dúvidas mais comuns de operadores e gestores.",
            roles: ["Todos os perfis"],
            time: "5 min",
            keywords: "faq dúvida pergunta câmera gravação internet retenção senha permissão excluir",
            related: ["inicio", "problemas-frequentes", "armazenamento"],
            body: `
              <section class="doc-section"><h2>Posso assistir e gravar ao mesmo tempo?</h2><p>Sim. A visualização e a gravação são funções diferentes, mas ambas dependem de a câmera e o sistema estarem disponíveis. Confirme o indicador de gravação.</p></section>
              <section class="doc-section"><h2>Por que vejo menos opções que outra pessoa?</h2><p>Os menus seguem sua função, grupo e câmeras autorizadas. Isso protege a instalação e é esperado.</p></section>
              <section class="doc-section"><h2>Quanto tempo as imagens ficam disponíveis?</h2><p>Depende da retenção e da capacidade de armazenamento definidas para a instalação. Consulte Armazenamento ou o responsável local.</p></section>
              <section class="doc-section"><h2>Excluir uma câmera apaga as gravações?</h2><p>Essa ação pode ter consequências sobre o acesso ao histórico. Não exclua uma câmera para resolver falha de conexão. Equipamentos substituídos devem seguir um procedimento de preservação e migração.</p></section>
              <section class="doc-section"><h2>Posso enviar uma gravação por mensagem?</h2><p>Somente se a política da empresa autorizar esse canal. Prefira o meio formal, registre o destinatário e compartilhe apenas o trecho necessário.</p></section>
              <section class="doc-section"><h2>O sistema continua funcionando sem internet?</h2><p>A operação dentro da instalação pode continuar de forma limitada, dependendo da estrutura local. Acesso externo, aplicativo e notificações podem ficar indisponíveis. Confirme o comportamento previsto com o responsável pela instalação.</p></section>
              <section class="doc-section"><h2>Quem deve alterar configurações de câmera?</h2><p>Somente administrador treinado, instalador ou suporte autorizado. Operadores devem registrar sintomas e preservar a operação.</p></section>`
          },
          {
            id: "checklists",
            title: "Checklists de operação",
            summary: "Rotinas curtas para abertura de turno, encerramento e atendimento de incidentes.",
            roles: ["Operador", "Gestor"],
            time: "5 min",
            keywords: "checklist turno rotina início fim incidente verificar",
            related: ["alertas", "continuidade-das-gravacoes", "status-e-indicadores"],
            body: `
              <section class="doc-section"><h2>Início do turno</h2><ul><li>Entrar com a própria conta.</li><li>Confirmar câmeras prioritárias ao vivo.</li><li>Verificar alertas ativos do turno anterior.</li><li>Testar uma gravação recente de cada área crítica.</li><li>Conferir espaço de armazenamento quando essa for sua atribuição.</li><li>Registrar qualquer irregularidade encontrada.</li></ul></section>
              <section class="doc-section"><h2>Durante uma ocorrência</h2><ul><li>Anotar o horário imediatamente.</li><li>Confirmar em mais de uma câmera quando possível.</li><li>Seguir o procedimento da instalação.</li><li>Preservar o trecho relevante.</li><li>Registrar fatos, evitando suposições.</li><li>Manter somente pessoas autorizadas informadas.</li></ul></section>
              <section class="doc-section"><h2>Encerramento do turno</h2><ul><li>Revisar alertas assumidos e não concluídos.</li><li>Repassar investigações abertas.</li><li>Comunicar câmeras offline e lacunas.</li><li>Fechar telas com imagens sensíveis.</li><li>Sair da conta.</li></ul></section>`
          }
        ]
      }
    ]
  };
})();
