'use strict';

/**
 * Conteúdo do Portal técnico do AjustCam.
 *
 * Este módulo fica em `src/`, não em `public/`, para que o navegador só receba
 * o documento depois da autorização feita pelo servidor. A interface trata os
 * blocos abaixo como dados e sempre escapa o texto; não há HTML executável no
 * conteúdo.
 */

const TECHNICAL_DOCUMENTATION_PERMISSION = 'technical_documentation.read';

const paragraph = (text) => ({ type: 'paragraph', text });
const callout = (tone, title, text) => ({ type: 'callout', tone, title, text });
const list = (items, ordered = false) => ({ type: 'list', ordered, items });
const steps = (items) => ({ type: 'steps', items });
const table = (columns, rows) => ({ type: 'table', columns, rows });
const keyValue = (items) => ({ type: 'keyValue', items });
const flow = (items) => ({ type: 'flow', items });
const code = (text, label = '') => ({ type: 'code', label, text });

const article = (id, title, summary, sourceFiles, blocks, tags = []) => ({
  id,
  title,
  summary,
  sourceFiles,
  blocks,
  tags,
});

const TECHNICAL_DOCUMENTATION = {
  schemaVersion: 2,
  product: 'AjustCam',
  title: 'Portal técnico do AjustCam',
  subtitle: 'Arquitetura, regras, fluxos, falhas, recuperação e operação do sistema',
  version: '2026.08.04.2',
  updatedAt: '2026-08-04',
  notice: 'Documento técnico vivo. Confirme comportamento crítico no código, nos testes e no ambiente da versão implantada antes de uma intervenção.',
  categories: [
    {
      id: 'fundamentos',
      title: 'Fundamentos e arquitetura',
      description: 'O mapa mental do produto, seus processos, dados e fronteiras.',
      articles: [
        article(
          'visao-geral',
          'Visão geral do sistema',
          'O que o AjustCam é, quais problemas resolve e como seus componentes cooperam.',
          ['pnpm-workspace.yaml', 'apps/api/src/app.module.ts', 'infra/docker-compose.yml'],
          [
            paragraph('O AjustCam é um VMS distribuído: recebe vídeo de câmeras IP, entrega imagem ao vivo, grava e indexa segmentos, detecta eventos, permite investigação e exportação e administra instalações remotas por uma Central separada. O sistema local continua sendo a autoridade sobre câmeras, usuários, gravações e reprodução daquela instalação.'),
            flow([
              'Câmera ou encoder publica/fornece RTSP, RTMP ou ONVIF',
              'MediaMTX e go2rtc normalizam a origem e entregam WebRTC, HLS ou fluxos internos',
              'API NestJS aplica autenticação, autorização, regras comerciais e coordena processos',
              'PostgreSQL preserva metadados; Redis/BullMQ coordena trabalhos assíncronos',
              'Web e Mobile apresentam ao vivo, playback, alarmes, investigação e administração',
              'Central recebe heartbeat e aplica provisionamento e política da instalação',
            ]),
            table(
              ['Componente', 'Responsabilidade principal', 'Pode operar sozinho?'],
              [
                ['API', 'Regras, acesso, catálogo, coordenação de vídeo e jobs', 'Não; depende do banco e de serviços de mídia conforme o fluxo'],
                ['Web', 'Interface principal do operador e administrador local', 'Não; consome a API'],
                ['Mobile', 'Monitoramento e resposta móvel', 'Não; consome a API e mídia'],
                ['MediaMTX/go2rtc', 'Ingestão e distribuição dos streams', 'Entrega mídia, mas não substitui regras e catálogo da API'],
                ['Serviço de IA', 'Movimento e análises avançadas', 'Degrada sem impedir funções básicas que não dependem dele'],
                ['Worker Go', 'Caminho legado/alternativo de gravação', 'Não é o gravador canônico atual'],
                ['Central', 'Frota, contrato, provisionamento e suporte', 'É separada das instalações e não armazena o vídeo delas'],
              ],
            ),
            callout('info', 'Regra de leitura', 'PostgreSQL é a verdade dos metadados; o arquivo físico ou objeto S3 é a verdade do conteúdo. Fluxos de gravação e retenção precisam manter as duas verdades conciliadas.'),
          ],
          ['arquitetura', 'mapa', 'componentes'],
        ),
        article(
          'topologia-runtime',
          'Processos, portas e dependências',
          'Como os serviços são implantados e que dependências afetam cada função.',
          ['infra/docker-compose.yml', 'apps/api/src/main.ts', 'infra/mediamtx.yml', 'infra/go2rtc.yml'],
          [
            paragraph('A implantação padrão usa serviços isolados em containers. A exposição pública deve terminar no proxy web; banco, Redis, callbacks internos, MediaMTX administrativo e serviço de IA permanecem em redes internas sempre que possível.'),
            table(
              ['Dependência indisponível', 'Efeito esperado', 'Recuperação'],
              [
                ['PostgreSQL', 'Operações com estado falham; a API não deve inventar sucesso', 'Health check, reconexão e retomada após o banco voltar'],
                ['Redis', 'Jobs e rotinas assíncronas ficam degradados; inicialização usa limites de retry', 'Workers e agendamentos retomam quando a conexão volta'],
                ['MediaMTX/go2rtc', 'Ao vivo e fontes internas deixam de iniciar ou reconectar', 'Reconexão com backoff e recriação controlada de paths'],
                ['Serviço de IA', 'Detecção avançada fica degradada; gravação contínua e playback continuam', 'Watchdog, reinício controlado e estado de saúde explícito'],
                ['Disco de gravação', 'Novas gravações são recusadas ou suspensas', 'Guard de espaço e retomada quando o volume volta a ser gravável'],
                ['Central', 'Instalação mantém funções locais conforme cache/política; heartbeat fica pendente', 'Conector retoma o heartbeat sem reiniciar a instalação'],
                ['S3', 'Offload e leitura apenas da nuvem falham', 'Retry controlado; cópia local só é apagada depois da confirmação do upload'],
              ],
            ),
            callout('warning', 'Readiness não é ordem de inicialização', 'depends_on apenas organiza a partida. Cada consumidor precisa tolerar que a dependência esteja iniciando, lenta ou temporariamente indisponível.'),
          ],
          ['runtime', 'docker', 'dependências'],
        ),
        article(
          'modelo-dados',
          'Modelo de dados e relações',
          'As entidades que dão forma a usuários, câmeras, eventos, gravações e investigação.',
          ['apps/api/prisma/schema.prisma', 'apps/api/prisma/migrations'],
          [
            table(
              ['Domínio', 'Entidades centrais', 'Regras importantes'],
              [
                ['Identidade', 'User, AuthSession, RolePermission', 'Sessões de refresh são revogáveis e permissões são verificadas no servidor'],
                ['Organização', 'Site, Area, SiteMapLayout, CameraGroup', 'Câmeras podem ser agrupadas e posicionadas; o acesso acompanha escopo'],
                ['Vídeo', 'Camera, Recording, ExportedClip', 'Arquivo é único por caminho; origem local/worker e localização em nuvem são explícitas'],
                ['Eventos', 'CameraEvent, UserEventReview, AlarmRule, AlarmInstance', 'Detecção, revisão humana e ciclo do alarme são estados distintos'],
                ['Investigação', 'Investigation, InvestigationItem', 'Itens preservados não devem ser removidos pela retenção'],
                ['Permissão', 'CameraPermission, CameraGroup e dono da câmera', 'VIEW, CONTROL, RECORD e ADMIN não são equivalentes'],
                ['Operação', 'SystemSetting, CloudStorage, AuditLog', 'Políticas mutáveis são persistidas e ações sensíveis devem ser auditadas'],
              ],
            ),
            list([
              'CameraStatus: UNKNOWN, ONLINE, OFFLINE ou ERROR.',
              'UserRole: SUPER_ADMIN, ADMIN, OPERATOR ou VIEWER.',
              'AlarmStatus: OPEN, ACKED ou RESOLVED; prioridade P1 a P4.',
              'GroupAccessStatus: ACTIVE, RESTRICTED ou SUSPENDED; não confundir com o status comercial da instalação na Central.',
              'RecordingSource distingue o gravador local canônico do caminho legado/worker.',
            ]),
            callout('warning', 'Mudanças de schema', 'Toda alteração estrutural exige migration revisada, backup compatível, ensaio de avanço e rollback operacional. Alterar apenas o schema Prisma não atualiza bancos existentes.'),
          ],
          ['prisma', 'postgresql', 'entidades'],
        ),
        article(
          'configuracao',
          'Configuração e precedência',
          'Onde vivem as decisões operacionais e como evitar valores divergentes.',
          ['apps/api/src/config', 'apps/api/src/settings', 'infra/.env.example', 'apps/central/src/server.js'],
          [
            paragraph('A configuração vem de variáveis de ambiente, registros de SystemSetting, cadastro de câmeras, política comercial da Central e opções da interface. A precedência depende do domínio: segredo e endpoint de infraestrutura ficam no ambiente; preferências operacionais mutáveis ficam no banco; decisões por câmera ficam no próprio registro.'),
            keyValue([
              ['Ambiente', 'Segredos, endpoints, limites de processo e feature flags de implantação.'],
              ['Banco local', 'Políticas de gravação, IA, offload, permissões e estado desejado.'],
              ['Central', 'Licença, restrições comerciais, provisionamento e armazenamento fornecido à instalação.'],
              ['Cliente web/mobile', 'Preferências de apresentação; nunca a decisão final de autorização.'],
            ]),
            callout('danger', 'Segredos', 'Não copie arquivos de ambiente, URLs com credenciais, tokens, chaves S3 ou senhas de câmera para este portal, logs, tickets ou diagnósticos. A documentação descreve o contrato, não os valores reais.'),
          ],
          ['configuração', 'segredos', 'precedência'],
        ),
      ],
    },
    {
      id: 'identidade',
      title: 'Identidade, acesso e segurança',
      description: 'Quem pode fazer o quê e em qual camada a decisão é aplicada.',
      articles: [
        article(
          'autenticacao-sessoes',
          'Autenticação e sessões',
          'Login web, mobile e Central; refresh, revogação e expiração.',
          ['apps/api/src/auth', 'apps/web/src/store/authStore.ts', 'apps/mobile/src', 'apps/central/src/server.js'],
          [
            paragraph('Na instalação, a API usa access token curto e sessão de refresh rotativa e revogável. O navegador recebe refresh por cookie HttpOnly; o mobile segue contrato próprio e armazena material sensível no armazenamento seguro da plataforma. A Central possui sessão independente, também por cookie HttpOnly.'),
            table(
              ['Evento', 'Resultado de segurança esperado'],
              [
                ['Logout', 'Revoga a sessão de refresh e remove a credencial local.'],
                ['Troca de senha', 'Invalida sessões existentes do usuário.'],
                ['Bloqueio/exclusão', 'Nega nova autenticação e invalida sessão conforme o fluxo administrativo.'],
                ['Mudança de papel/permissão', 'A autorização atual deve refletir o novo estado, sem confiar apenas no token antigo.'],
                ['Dispositivo perdido', 'Administrador revoga sessões; o cliente limpa dados locais quando receber negação.'],
                ['Sessão expirada', 'UI interrompe ações, tenta refresh permitido e volta ao login se recusado.'],
              ],
            ),
            callout('info', 'JWT stateless não significa irrevogável', 'O access token tem vida curta, mas a continuidade depende de uma sessão de refresh persistida. Revogação imediata também usa versão/autorização atual nas operações sensíveis.'),
          ],
          ['login', 'jwt', 'sessão', 'refresh'],
        ),
        article(
          'autorizacao',
          'Papéis, permissões e escopo de câmera',
          'A autorização em camadas e as regras especiais de conteúdo privado.',
          ['apps/api/src/auth', 'apps/api/src/access-control', 'apps/api/src/camera-permissions', 'apps/api/src/role-permissions'],
          [
            paragraph('A UI pode ocultar ações, mas a decisão real acontece na API. Guardas globais validam identidade, papel, permissão e situação comercial; o controle por recurso verifica câmera, grupo e proprietário antes de liberar conteúdo ou comando.'),
            table(
              ['Nível de câmera', 'Capacidade típica'],
              [
                ['VIEW', 'Ver ao vivo e conteúdo autorizado.'],
                ['CONTROL', 'Operar PTZ ou relés, além da visualização permitida.'],
                ['RECORD', 'Acionar ou administrar gravação dentro do escopo.'],
                ['ADMIN', 'Gerenciar configuração e delegação da câmera.'],
              ],
            ),
            list([
              'Câmera privada: somente proprietário e delegados veem o conteúdo; administrador pode gerenciar metadados sem ganhar automaticamente acesso ao vídeo.',
              'Acesso direto por ID deve passar pela mesma regra usada nas listagens.',
              'Playback, download, thumbnail, exportação e evidência repetem a autorização; não herdam confiança do frontend.',
              'Tokens de mídia são curtos, limitados ao recurso e não substituem a sessão para ações administrativas.',
            ]),
            callout('warning', 'Dois tipos de restrição', 'Restrição de grupo controla usuários e câmeras dentro de uma instalação. Restrição comercial da Central controla capacidades da instalação inteira. São políticas diferentes.'),
          ],
          ['rbac', 'permissões', 'câmera privada'],
        ),
        article(
          'fronteiras-seguranca',
          'Fronteiras de confiança e ameaças',
          'Entradas não confiáveis, proteção de rede e tratamento de credenciais.',
          ['apps/api/src/cameras', 'apps/api/src/camera-stream', 'infra/ajustcam.nginx.conf', 'infra/mediamtx.yml'],
          [
            table(
              ['Entrada', 'Risco principal', 'Proteção esperada'],
              [
                ['URL/IP de câmera', 'SSRF, DNS rebinding, portas/protocolos indevidos', 'Normalização, resolução de DNS, política de redes permitidas e validação no momento da conexão'],
                ['Nome/caminho de arquivo', 'Path traversal ou symlink', 'Raiz canônica, resolução real e rejeição fora do diretório'],
                ['Argumentos de mídia', 'Injeção de shell e segredo em argv/log', 'spawn sem shell, argumentos separados e credencial por descritor protegido'],
                ['Upload/importação', 'Arquivo malicioso ou consumo de disco', 'Tipo/tamanho/raiz controlados e processamento isolado'],
                ['Callback interno', 'Falsificação de serviço', 'Token forte de serviço e rede interna restrita'],
                ['Diagnóstico', 'Vazamento de segredo', 'Sanitização antes de persistir ou exibir'],
              ],
            ),
            callout('danger', 'Princípio operacional', 'Uma URL válida sintaticamente ainda pode apontar para localhost, rede privada, link-local ou metadata. Validação e conexão precisam compartilhar a mesma decisão de endereço.'),
          ],
          ['segurança', 'ssrf', 'credenciais'],
        ),
        article(
          'auditoria',
          'Auditoria e rastreabilidade',
          'Quais eventos devem deixar rastro e o que nunca deve ser registrado.',
          ['apps/api/src/audit', 'apps/central/src/server.js'],
          [
            list([
              'Autenticação, falhas e bloqueios de login.',
              'Alteração de usuário, papel, permissão, câmera e política de retenção.',
              'Visualização, download, exportação e inclusão de evidência quando exigido pelo domínio.',
              'Mudança comercial, provisionamento, emissão/consumo de instalador e acesso ao portal técnico.',
              'Ações de atualização, restauração, retenção e exclusão com resultado verificável.',
            ]),
            paragraph('Um evento útil registra ator, ação, alvo, horário, origem e resultado. Senhas, refresh tokens, chaves de câmera, URL RTSP autenticada, token de instalador e segredo S3 nunca entram no evento.'),
            callout('info', 'Retenção do log', 'O limite e o destino do log precisam acompanhar o risco e a política da empresa. Um buffer local limitado ajuda operação, mas não substitui exportação imutável quando houver requisito de conformidade.'),
          ],
          ['auditoria', 'logs', 'rastreabilidade'],
        ),
      ],
    },
    {
      id: 'video',
      title: 'Câmeras, vídeo ao vivo e mídia',
      description: 'Da origem da câmera até a tela do operador.',
      articles: [
        article(
          'cadastro-camera',
          'Cadastro e ciclo de vida da câmera',
          'Perfis, origem, credenciais, estado e desativação sem perda de histórico.',
          ['apps/api/src/cameras', 'apps/api/src/cameras/onvif-events.service.ts', 'apps/api/src/ptz/onvif-ptz.service.ts', 'apps/web/src/pages/CamerasPage.tsx'],
          [
            paragraph('Uma câmera guarda identidade, endereço, credencial criptografada, modo de origem, perfis de live/gravação/análise, política de gravação, IA, alarme, grupo, proprietário e status observado. Desativar interrompe consumo e gravação sem apagar o histórico.'),
            keyValue([
              ['Canal de live', 'Perfil escolhido para baixa latência e visualização.'],
              ['Canal de gravação', 'Perfil escolhido para qualidade e retenção.'],
              ['Canal de análise', 'Perfil mais leve quando a câmera oferece um substream adequado.'],
              ['rtsp_pull', 'A plataforma abre uma conexão na câmera.'],
              ['rtmp_push', 'A câmera abre a conexão e publica na plataforma.'],
            ]),
            steps([
              'Validar endereço e limites de rede conforme a política da instalação.',
              'Descobrir capacidades ONVIF quando disponível, sem confiar cegamente na resposta.',
              'Salvar credencial cifrada e nunca devolvê-la em respostas ou logs.',
              'Configurar paths de mídia determinísticos e evitar colisão entre câmeras/perfis.',
              'Testar origem e codec; só então marcar saúde conforme frames realmente recebidos.',
              'Ao editar ou desativar, encerrar leases e processos antigos antes de assumir o novo estado.'
            ]),
          ],
          ['câmera', 'onvif', 'rtsp', 'rtmp'],
        ),
        article(
          'ao-vivo',
          'Fluxo de visualização ao vivo',
          'Seleção de protocolo, criação da fonte, reconexão e limpeza do player.',
          ['apps/api/src/camera-stream', 'apps/web/src/components/LiveStreamPlayer.tsx', 'infra/mediamtx.yml'],
          [
            flow([
              'Tela pede uma URL de mídia para uma câmera autorizada',
              'API verifica sessão, permissão, grupo, câmera privada e política comercial',
              'API garante a fonte no MediaMTX/Source Gateway e emite token curto de mídia',
              'Player tenta o protocolo compatível de menor latência',
              'WebRTC/WHEP é preferido; HLS/LL-HLS serve de fallback conforme codec e navegador',
              'Player observa frames, stall e tela preta; reconecta com backoff sem acumular recursos',
              'Ao sair, cancela timers, HLS, peer connection, fetch e lease da IA',
            ]),
            list([
              'A grade pode usar substream; a câmera selecionada pode subir a qualidade.',
              'A escolha bem-sucedida de protocolo pode ser lembrada por câmera por tempo limitado para reduzir nova negociação.',
              'HEVC/H.265 não é universal no navegador. A plataforma detecta suporte e usa perfil H.264 ou transcode quando realmente necessário.',
              'A interface preserva o último quadro durante reconexão curta para evitar piscar, mas continua mostrando o estado real.',
              'FPS zero por tempo suficiente indica ausência de frames, mesmo que a sessão de transporte ainda esteja conectada.'
            ]),
            callout('warning', 'Online não é socket conectado', 'A câmera só está útil quando frames válidos chegam. Autenticar ou publicar o nome do stream sem enviar vídeo não prova disponibilidade.'),
          ],
          ['live', 'webrtc', 'hls', 'reconexão'],
        ),
        article(
          'source-gateway',
          'Source Gateway e controle de conexões',
          'Como impedir conexões duplicadas e tempestades de reinício.',
          ['apps/api/src/camera-stream/source-gateway.service.ts', 'apps/api/src/camera-stream', 'services/ai-service-python'],
          [
            paragraph('O Source Gateway mantém um estado por câmera e perfil, concede leases aos consumidores e limita quantas conexões externas existem para a mesma origem. A IA é o primeiro consumidor seguro desse caminho; outras rotas podem continuar diretas enquanto a migração estiver sob feature flag.'),
            table(
              ['Mecanismo', 'Finalidade'],
              [
                ['Lease', 'Saber quem ainda precisa da origem e liberar quando o último consumidor sair.'],
                ['Idle TTL', 'Evitar derrubar/reabrir a fonte entre acessos próximos.'],
                ['Stall timeout', 'Detectar origem conectada que deixou de produzir frames.'],
                ['Backoff com jitter', 'Evitar que muitas câmeras reiniciem no mesmo instante.'],
                ['Circuit breaker', 'Parar tentativas agressivas após falhas repetidas.'],
                ['Limite externo', 'Impedir que live, IA e gravação abram fontes redundantes sem controle.'],
              ],
            ),
            callout('info', 'Estado desejado e observado', 'Ter uma lease significa que existe demanda; não significa que a fonte está saudável. Estado e métricas distinguem abertura, disponibilidade, degradação e falha.'),
          ],
          ['gateway', 'lease', 'backoff'],
        ),
        article(
          'rtmp-push',
          'Ingestão RTMP push',
          'Câmeras que publicam para o servidor e aquelas que ignoram o path configurado.',
          ['apps/api/src/cameras', 'apps/api/src/camera-stream', 'infra/mediamtx.yml'],
          [
            paragraph('No modo push, a plataforma fornece host, porta e uma chave de ingestão. A chave recuperável fica cifrada e a forma usada para validação fica protegida. Algumas câmeras usam apenas host/porta do campo informado e publicam um path próprio; o AjustCam pode observar e vincular esse path depois de confirmação administrativa.'),
            steps([
              'Criar credencial de ingestão aleatória para a câmera.',
              'Autorizar publicação sem expor a credencial em logs ou respostas indevidas.',
              'Observar o path realmente publicado e confirmar que pertence à câmera esperada.',
              'Vincular a origem observada à câmera sem permitir colisão com outro cadastro.',
              'Marcar online apenas depois de receber uma track de vídeo e frames.'
            ]),
            callout('warning', 'Falha do firmware', 'O servidor pode aceitar publish e a câmera encerrar antes do primeiro frame. Nesse caso o caminho do servidor está disponível, mas a origem não forneceu vídeo; teste controlado com um publicador conhecido separa as causas.'),
          ],
          ['rtmp', 'push', 'firmware'],
        ),
        article(
          'ptz-reles',
          'PTZ, presets e relés',
          'Comandos ativos sobre equipamentos e suas regras de segurança.',
          ['apps/api/src/ptz', 'apps/web/src/pages/PTZPage.tsx'],
          [
            paragraph('PTZ e relé são comandos de controle, não simples visualização. A API exige a permissão correspondente, valida que a câmera oferece a capacidade e limita parâmetros antes de chamar ONVIF ou o adaptador do equipamento.'),
            list([
              'Movimento contínuo precisa de comando de parada mesmo quando o navegador fecha ou perde foco.',
              'Preset deve pertencer à câmera acessível e não aceitar referência cruzada por ID.',
              'Falha e timeout são mostrados como falha; a UI não anuncia sucesso antecipado.',
              'Relé pode controlar equipamento físico crítico e deve gerar auditoria quando aplicável.',
            ]),
          ],
          ['ptz', 'onvif', 'relé'],
        ),
      ],
    },
    {
      id: 'gravacao',
      title: 'Gravação, movimento e inteligência',
      description: 'Como o vídeo vira arquivo, evento e material pesquisável.',
      articles: [
        article(
          'pipeline-gravacao',
          'Pipeline de gravação',
          'Do estado desejado ao MP4 validado e registrado.',
          ['apps/api/src/recordings', 'apps/api/src/recordings/recording-process-manager.service.ts', 'apps/api/src/jobs'],
          [
            flow([
              'Regra contínua, manual ou evento de movimento solicita gravação',
              'Gerenciador verifica câmera, contrato, volume gravável e espaço mínimo',
              'FFmpeg captura em segmentos TS usando copy por padrão',
              'Segmento fechado é remuxado para MP4 temporário',
              'ffprobe confirma vídeo e duração antes da publicação final',
              'Arquivo é renomeado/estabilizado e registro idempotente é criado no banco',
              'Thumbnail e offload são enfileirados depois do registro válido',
            ]),
            keyValue([
              ['Estado desejado', 'recordingEnabled no banco expressa que a câmera deve gravar.'],
              ['Estado observado', 'Processo em execução, segmento recente, erro, suspensão por disco.'],
              ['Segmento padrão', 'Cinco minutos no modo contínuo; limites impedem valores absurdos.'],
              ['Codec', 'Copy evita custo e perda de qualidade; transcode é exceção compatível.'],
              ['Auto-start', 'Controlado por configuração; quando ativo, reconcilia câmeras contínuas habilitadas.'],
            ]),
            callout('info', 'Fechamento antes do registro', 'O banco só deve apontar para um arquivo que já terminou de ser escrito e foi validado. Arquivo aberto não entra em playback nem offload.'),
          ],
          ['gravação', 'ffmpeg', 'segmento'],
        ),
        article(
          'falhas-gravacao',
          'Falhas e recuperação da gravação',
          'Disco cheio, crash, arquivos órfãos e restart sem tempestade.',
          ['apps/api/src/recordings/recording-process-manager.service.ts', 'apps/api/src/recordings'],
          [
            table(
              ['Falha', 'Estado possível', 'Resposta esperada'],
              [
                ['Disco quase cheio', 'Desejo ativo, processo suspenso', 'Parar novas escritas, emitir evento e retomar após espaço seguro'],
                ['FFmpeg encerra', 'Último TS possivelmente fechado', 'Finalizar o que for válido e reiniciar com backoff limitado'],
                ['API reinicia', 'TS/MP4 sem registro', 'Varredura de órfãos na partida e periodicamente'],
                ['Remux falha', 'TS válido ainda disponível', 'Retry limitado; depois quarentena persistente, sem apagar a origem'],
                ['Banco indisponível', 'Arquivo pode existir sem metadado', 'Preservar arquivo e reconciliar; nunca apagar como se estivesse registrado'],
                ['Arquivo ausente', 'Registro aponta para mídia indisponível', 'Playback relata indisponibilidade e integridade sinaliza divergência'],
              ],
            ),
            list([
              'O segmento mais novo é excluído da varredura enquanto pode estar aberto.',
              'Parada solicitada não entra no mecanismo de reinício automático.',
              'Reinícios repetidos têm janela, limite e backoff para não derrubar o host.',
              'Duração/PTS absurdo é saneado quando o vídeo é recuperável, em vez de descartar conteúdo válido.',
            ]),
          ],
          ['recuperação', 'disco', 'órfão'],
        ),
        article(
          'movimento',
          'Detecção de movimento e gravação por evento',
          'MOG2, ONVIF nativo, pre-roll, post-roll e significado do motionScore.',
          ['apps/api/src/ai', 'apps/api/src/recordings', 'services/ai-service-python/stream_processor.py'],
          [
            paragraph('Movimento pode vir do MOG2 do sistema ou do evento nativo da câmera. No modo SYSTEM, a IA analisa apenas câmeras habilitadas e armadas para movimento. No modo CAMERA, o evento ONVIF é preferido e o MOG2 pode servir de fallback quando a liveness nativa falha.'),
            flow([
              'Frame mais recente entra no detector, sem fila crescente',
              'MOG2 aplica warm-up, zonas de inclusão/exclusão e filtros de mudança global',
              'Evento válido abre ou prolonga a gravação',
              'Novo evento reinicia o post-roll',
              'Pre-roll opcional conserva segundos anteriores em ring buffer',
              'Segmentos recebem motionScore e podem ter retenção diferenciada',
            ]),
            keyValue([
              ['motionScore > 0', 'Movimento conhecido no segmento.'],
              ['motionScore = 0', 'Ausência conhecida de movimento.'],
              ['motionScore = -1', 'Estado desconhecido; protegido da retenção curta para evitar perda silenciosa.'],
              ['Confirmação por objeto', 'Timeout/falha é desconhecido e não suprime gravação; somente falso confirmado pode suprimir.'],
            ]),
            callout('warning', 'MOG2 não é detector de objeto', 'MOG2 detecta alteração de pixels/fundo. Ele pode disparar gravação, mas não deve desenhar caixas “pessoa/carro” nem afirmar uma classe que não inferiu.'),
          ],
          ['mog2', 'movimento', 'onvif', 'post-roll'],
        ),
        article(
          'ia',
          'Serviço de IA e análises avançadas',
          'Processadores por câmera, QoS, modelos e degradação.',
          ['services/ai-service-python/main.py', 'services/ai-service-python/stream_processor.py', 'apps/api/src/ai', 'apps/api/src/gpu'],
          [
            paragraph('O serviço FastAPI é ativo. Operações mutáveis internas exigem token forte de serviço. Cada câmera possui no máximo um StreamProcessor controlado; captura e inferência trabalham com fila de um frame, descartando atraso para manter o resultado atual.'),
            table(
              ['Modo', 'Comportamento'],
              [
                ['Movimento', 'MOG2 leve, resolução e FPS reduzidos, direcionado a gatilho de gravação.'],
                ['Objeto', 'Inferência avançada condicionada à licença e configuração.'],
                ['Face', 'Fluxo avançado separado, também condicionado a permissão e capacidade.'],
                ['QoS base/grade/selecionada', 'Aumenta análise enquanto há interesse visual e volta ao nível base após o lease.'],
              ],
            ),
            list([
              'Câmera desconectada não pode acumular threads, frames ou retries ilimitados.',
              'Processadores órfãos são encerrados após verificações repetidas.',
              'Processador degradado reinicia apenas após limiar e cooldown.',
              'H.265 pode usar um substream H.264 de grade como entrada de análise.',
              'Movimento falha de forma conservadora porque pode controlar gravação; IA avançada falha fechada quando a Central não confirma direito comercial.',
              'Overlay ao vivo é destinado a detecção avançada; movimento básico não desenha caixas de classe.'
            ]),
          ],
          ['ia', 'openvino', 'qos', 'threads'],
        ),
        article(
          'alarmes-notificacoes',
          'Alarmes, notificações e revisão',
          'Como eventos técnicos viram uma ocorrência tratável por pessoas.',
          ['apps/api/src/alarms', 'apps/api/src/notifications', 'apps/api/src/review'],
          [
            flow([
              'Evento de câmera, IA ou saúde satisfaz uma regra de alarme',
              'Instância OPEN recebe prioridade, origem, câmera e horário',
              'Fila seleciona canais e destinatários autorizados',
              'Operador reconhece (ACKED) e depois resolve (RESOLVED)',
              'Auditoria preserva as transições e o ator',
            ]),
            paragraph('Notificação é uma entrega do alarme, não o alarme em si. Falha de push não deve apagar a ocorrência. Mutes, dispositivos e recibos controlam entrega; a tela de alarmes continua sendo a fonte operacional.'),
            callout('info', 'Prioridade', 'P1 a P4 representa urgência operacional. A regra precisa equilibrar sensibilidade e ruído; excesso de alarmes reduz a capacidade humana de resposta.'),
          ],
          ['alarme', 'push', 'revisão'],
        ),
      ],
    },
    {
      id: 'playback',
      title: 'Playback, evidências e armazenamento',
      description: 'Leitura do histórico, exportação, integridade, nuvem e retenção.',
      articles: [
        article(
          'playback',
          'Playback e linha do tempo',
          'Como a busca autorizada encontra e entrega segmentos locais ou em nuvem.',
          ['apps/api/src/recordings', 'apps/web/src/pages/PlaybackPage.tsx'],
          [
            flow([
              'Cliente consulta intervalo e câmeras',
              'API reduz o conjunto às câmeras acessíveis',
              'Metadados compõem linha do tempo, gaps e estado de prontidão',
              'API emite token curto para play, download ou thumbnail',
              'Arquivo local usa streaming com Range; remoto usa Range direto do S3',
              'Player troca segmentos e representa lacunas sem inventar continuidade',
            ]),
            list([
              'Listagens são paginadas/limitadas e não retornam histórico ilimitado.',
              'Se o codec/contêiner não for reproduzível, uma cópia compatível pode ser gerada sob demanda em fila de baixa prioridade.',
              'Thumbnail e sprite são derivados; a gravação original continua sendo a evidência primária.',
              'Registro sem arquivo deve produzir erro explícito, não resposta vazia de sucesso.',
              'Download por ID repete autorização e valida a raiz física contra traversal e symlink.'
            ]),
          ],
          ['playback', 'range', 'timeline'],
        ),
        article(
          'exportacao-evidencia',
          'Exportação, evidências e investigações',
          'Recortes, ZIP, preservação e cadeia operacional.',
          ['apps/api/src/evidence', 'apps/api/src/investigations', 'apps/api/src/recordings'],
          [
            paragraph('Exportação gera um derivado para compartilhamento; evidência e investigação adicionam contexto e preservação. A criação deve ser assíncrona quando envolve mídia pesada, com progresso e falha observáveis.'),
            table(
              ['Objeto', 'Finalidade', 'Retenção'],
              [
                ['ExportedClip', 'Recorte reproduzível de um período', 'Política própria; não altera o original'],
                ['Evidência', 'Material selecionado com integridade e contexto', 'Protegida contra limpeza enquanto válida'],
                ['InvestigationItem', 'Liga gravação/evento a um caso', 'Legal hold impede retenção destrutiva'],
                ['ZIP em lote', 'Entrega conveniente de múltiplos itens', 'Artefato temporário com expiração definida'],
              ],
            ),
            list([
              'Intervalo exportado não pode acessar câmera fora do escopo do solicitante.',
              'Nome fornecido pelo usuário nunca vira caminho físico sem normalização controlada.',
              'HMAC/assinatura e expiração, quando usados em links, são verificados antes da leitura.',
              'Exclusão da origem protegida exige retirar a proteção por um fluxo autorizado e auditado.'
            ]),
          ],
          ['evidência', 'investigação', 'exportação'],
        ),
        article(
          'armazenamento-local',
          'Armazenamento local e dimensionamento',
          'Espaço útil, reserva operacional e impacto de bitrate e retenção.',
          ['apps/api/src/recordings', 'apps/web/src/pages/StoragePage.tsx', 'apps/web/public/armazenamento'],
          [
            paragraph('O consumo depende de bitrate médio, quantidade de câmeras, horas gravadas por dia, dias de retenção e overhead. Resolução e FPS não determinam sozinhos o volume; duas câmeras 1080p podem ter bitrates muito diferentes.'),
            code('bytes ≈ câmeras × bitrate_em_bits/s ÷ 8 × segundos_gravados × dias', 'Estimativa básica'),
            list([
              'Reserve espaço para sistema, banco, segmentos abertos, remux, thumbnails, exportações e recuperação.',
              'O guard recusa início abaixo do mínimo absoluto/percentual e suspende acima do limite configurado.',
              'RAID melhora disponibilidade, mas não é backup.',
              'Medição real por modelo/cena durante alguns dias é mais confiável que bitrate nominal.',
              'Gravação por movimento reduz média somente quando a cena realmente fica inativa e o detector está calibrado.'
            ]),
            callout('warning', 'Disco em 100%', 'Não dimensione para ocupar toda a capacidade anunciada. Banco, sistema de arquivos e fechamento de MP4 precisam de margem para recuperar com segurança.'),
          ],
          ['disco', 'bitrate', 'dimensionamento'],
        ),
        article(
          'offload-s3',
          'Offload para S3',
          'Upload, confirmação, leitura histórica e remoção local segura.',
          ['apps/api/src/cloud-storage', 'apps/api/src/jobs', 'apps/central/src/cloud-storage.js'],
          [
            flow([
              'MP4 fechado e registro válido criam job deduplicado de offload',
              'Worker escolhe o storage ativo e uma chave determinística',
              'Arquivo pequeno usa PUT; grande usa multipart em chunks',
              'Upload finaliza e HEAD confirma o objeto remoto',
              'Banco recebe cloudKey, storage de origem e uploadedAt',
              'Política decide quando a cópia local pode ser removida',
              'Playback futuro lê do storage de origem com Range',
            ]),
            keyValue([
              ['Política padrão', 'Offload desativado até decisão explícita da instalação.'],
              ['Tipos padrão ao ativar', 'Movimento e manual; contínuo precisa ser escolhido.'],
              ['keepLocalCopy', 'Preserva local quando verdadeiro, salvo modo direto/mount com regra específica.'],
              ['localWindowHours', 'Janela local antes de liberar remoção em tier.'],
              ['Concorrência', 'Configurável, limitada; padrão operacional prioriza não saturar disco/rede.'],
            ]),
            list([
              'Falha multipart aborta a sessão remota quando possível.',
              'Nunca apagar local antes de confirmação remota e persistência do marcador no banco.',
              'Novas gravações usam o storage ativo; gravações antigas continuam ligadas ao storage que as recebeu.',
              'Storage arquivado fica disponível para leitura e não recebe novos objetos.',
              'Segredo S3 fica cifrado na Central e não aparece na UI, log ou documento.'
            ]),
          ],
          ['s3', 'offload', 'multipart'],
        ),
        article(
          'retencao',
          'Retenção e exclusão segura',
          'Como liberar espaço sem perder material protegido ou deixar banco e disco divergentes.',
          ['apps/api/src/recordings', 'apps/api/src/jobs'],
          [
            paragraph('A retenção é um workflow destrutivo e idempotente. Ela escolhe candidatos por política, exclui qualquer item protegido, registra intenção durável, move/quarentena quando necessário e só conclui quando arquivo, nuvem, derivados e banco chegaram a um estado conhecido.'),
            steps([
              'Calcular cutoff por câmera, tipo e motionScore.',
              'Excluir candidatos vinculados a evidência, investigação ou legal hold.',
              'Persistir journal/estado de exclusão antes do efeito irreversível.',
              'Remover cópias e derivados apenas nas raízes permitidas.',
              'Atualizar banco transacionalmente e registrar resultado.',
              'Na reinicialização, reconciliar operações interrompidas e quarentena.'
            ]),
            callout('danger', 'Desconhecido não é sem movimento', 'motionScore -1 representa ausência de informação, portanto não pode receber automaticamente a retenção curta de “sem movimento”.'),
          ],
          ['retenção', 'exclusão', 'integridade'],
        ),
      ],
    },
    {
      id: 'clientes',
      title: 'Aplicações e experiência',
      description: 'O papel de cada interface e os recursos visíveis aos usuários.',
      articles: [
        article(
          'web',
          'Aplicação web da instalação',
          'Páginas, responsabilidades e limites do frontend principal.',
          ['apps/web/src/App.tsx', 'apps/web/src/pages', 'apps/web/src/components'],
          [
            table(
              ['Área', 'Finalidade'],
              [
                ['Ao vivo', 'Grade, layouts, qualidade, estado, overlay autorizado e foco em uma câmera.'],
                ['Playback/Revisão', 'Linha do tempo, eventos, download e marcação revisada.'],
                ['PTZ/Wall', 'Controle de câmera e monitor de parede.'],
                ['Câmeras/Grupos/Mapas', 'Inventário, organização física e delegação.'],
                ['Alarmes/Investigação', 'Triagem, reconhecimento, resolução e preservação.'],
                ['Armazenamento', 'Capacidade, retenção, nuvem e saúde.'],
                ['Usuários/Papéis', 'Identidade e permissões locais.'],
                ['Configurações/IA', 'Políticas operacionais do sistema e análise.'],
                ['App builder', 'Configuração de distribuição móvel quando habilitada.'],
              ],
            ),
            callout('info', 'Frontend não autoriza', 'Botão oculto melhora a experiência, mas toda leitura e mutação continua sendo negada pela API quando a permissão não existe.'),
          ],
          ['web', 'páginas', 'frontend'],
        ),
        article(
          'mobile',
          'Aplicativo mobile',
          'Sessão segura, live, reprodução, push e ciclo de vida do dispositivo.',
          ['apps/mobile/src', 'apps/mobile/app.config.js'],
          [
            list([
              'Credenciais persistentes ficam no SecureStore; dados comuns podem usar armazenamento não secreto.',
              'Logout remove tokens, cache sensível e arquivos temporários da conta.',
              'Biometria protege a reabertura local, mas não substitui autenticação do servidor.',
              'Background/foreground pausa e retoma player, timers e reconexões sem duplicar sessões.',
              'Download e compartilhamento criam arquivo temporário e aplicam limpeza posterior.',
              'Push identifica o dispositivo, respeita mute e abre o recurso somente depois de revalidar a sessão.',
              'Proteção de captura/tela recente é aplicada nas telas sensíveis compatíveis com a plataforma.'
            ]),
            callout('warning', 'Servidor arbitrário', 'A URL da instalação deve ser validada e apresentada claramente. Permitir HTTP ou certificados inválidos fora de um modo explicitamente controlado expõe sessão e vídeo.'),
          ],
          ['mobile', 'securestore', 'push'],
        ),
        article(
          'central',
          'Limite entre instalação e Central',
          'O que a Central gerencia e o que permanece exclusivamente local.',
          ['apps/central/README.md', 'apps/central/src/server.js', 'apps/api/src/cloud-connector'],
          [
            table(
              ['Central conhece/decide', 'Instalação conhece/decide'],
              [
                ['Identidade da instalação, licença, heartbeat e alertas resumidos', 'Usuários locais, permissões por câmera e conteúdo de vídeo'],
                ['Provisionamento e artefato imutável de instalação', 'Cadastro e credenciais das câmeras'],
                ['Política comercial e capacidades contratadas', 'Política operacional de gravação, retenção e IA dentro do permitido'],
                ['Credencial de storage provisionado, cifrada', 'Quais tipos sobem e quando a cópia local é removida'],
                ['Saúde agregada e diagnóstico sanitizado', 'Logs detalhados e arquivos de mídia'],
              ],
            ),
            paragraph('A instalação envia heartbeat para fora; a Central não precisa abrir acesso direto ao banco ou ao volume de vídeo. A perda temporária da Central não deve apagar dados locais nem bloquear indevidamente funções de segurança básicas.'),
            callout('info', 'Este portal', 'A documentação técnica está hospedada na Central, mas é uma referência do produto inteiro. Ela requer sessão interativa e a permissão técnica específica.'),
          ],
          ['central', 'heartbeat', 'fronteira'],
        ),
        article(
          'politica-comercial',
          'Estados comerciais da instalação',
          'ACTIVE, GRACE, RESTRICTED e SUSPENDED sem destruir o histórico do cliente.',
          ['apps/central/src/server.js', 'apps/api/src/cloud-connector'],
          [
            table(
              ['Estado', 'Novas operações', 'Histórico'],
              [
                ['ACTIVE', 'Capacidades contratadas liberadas', 'Liberado conforme usuário'],
                ['GRACE', 'Operação preservada durante tolerância', 'Liberado conforme usuário'],
                ['RESTRICTED', 'Bloqueia novas câmeras, IA avançada e atualização; mantém live e gravação', 'Playback, exportação e evidências preservados'],
                ['SUSPENDED', 'Bloqueia live, nova gravação e IA', 'Login administrativo, playback e exportação são preservados'],
              ],
            ),
            callout('warning', 'Nunca apagar por contrato', 'Suspensão comercial muda autorização de capacidades; não remove gravações, usuários ou configuração e não substitui a política normal de retenção.'),
          ],
          ['licença', 'contrato', 'restrição'],
        ),
      ],
    },
    {
      id: 'operacao',
      title: 'Operação, filas e disponibilidade',
      description: 'Rotinas de fundo, métricas, diagnóstico e comportamento em falhas.',
      articles: [
        article(
          'bullmq',
          'Redis, BullMQ e trabalhos assíncronos',
          'Filas, agendamentos, retries, deduplicação e limpeza.',
          ['apps/api/src/jobs', 'apps/api/src/jobs/jobs.module.ts'],
          [
            table(
              ['Fila/rotina', 'Função'],
              [
                ['alarm-notification', 'Entrega notificações de alarmes.'],
                ['camera-health-check', 'Atualiza saúde e disponibilidade das câmeras.'],
                ['recording-cleanup', 'Executa retenção e reconciliação.'],
                ['thumbnail-generation', 'Gera derivados visuais de segmentos fechados.'],
                ['evidence-export / recording-export', 'Cria clips, pacotes e exportações pesadas.'],
                ['push-receipts', 'Processa confirmação/estado de entrega mobile.'],
                ['cloud-offload', 'Transfere gravações validadas ao storage remoto.'],
              ],
            ),
            list([
              'Job id estável/deduplicado impede trabalho duplicado quando o evento é reenviado.',
              'Retry tem limite e backoff; erro permanente termina como falha observável.',
              'removeOnComplete/removeOnFail mantêm Redis sob limite sem eliminar diagnóstico recente demais.',
              'Offload roda após o segmento e também periodicamente como recuperação.',
              'Agendamentos não bloqueiam indefinidamente a inicialização se Redis estiver fora.'
            ]),
          ],
          ['redis', 'bullmq', 'jobs'],
        ),
        article(
          'health-observabilidade',
          'Health checks e observabilidade',
          'Como diferenciar processo vivo, serviço pronto e função realmente saudável.',
          ['apps/api/src/health', 'apps/api/src/observability', 'apps/api/src/integrity', 'apps/central/src/server.js'],
          [
            table(
              ['Sinal', 'Pergunta respondida'],
              [
                ['Liveness', 'O processo responde ou deve ser reiniciado?'],
                ['Readiness', 'Dependências mínimas permitem receber tráfego?'],
                ['Saúde da câmera', 'Frames recentes chegaram e o codec é válido?'],
                ['Saúde da gravação', 'Processo e segmento recente correspondem ao estado desejado?'],
                ['Integridade', 'Banco, arquivos locais e objetos remotos concordam?'],
                ['Heartbeat Central', 'A instalação comunicou métricas e política recentemente?'],
              ],
            ),
            paragraph('Logs devem ter correlação por instalação/câmera/job sem incluir segredo. Métricas úteis incluem tempo para primeiro frame, FPS observado, reconnects, processos FFmpeg, fila pendente, falhas de offload, espaço livre e idade do último segmento.'),
          ],
          ['health', 'métricas', 'logs'],
        ),
        article(
          'diagnostico-live',
          'Runbook: live lenta, piscando ou sem FPS',
          'Uma sequência de diagnóstico que separa origem, mídia, API, rede e navegador.',
          ['apps/web/src/components/LiveStreamPlayer.tsx', 'apps/api/src/camera-stream', 'infra/mediamtx.yml'],
          [
            steps([
              'Confirmar horário, câmera, perfil e se o problema afeta um ou todos os clientes.',
              'Verificar se a origem entrega frames no perfil configurado; conexão sem frame não basta.',
              'Comparar tempo de abertura RTSP/RTMP com tempo de disponibilidade no MediaMTX.',
              'Contar fontes e processos por câmera para detectar duplicação ou storm.',
              'Medir tempo da emissão do token, negociação WHEP/HLS e primeiro frame no browser.',
              'Conferir codec real, keyframe/GOP e suporte do navegador; evitar transcode desnecessário.',
              'Observar stall, perda, CPU, disco e rede; correlacionar com reinícios recentes.',
              'Testar um publicador/fonte sintética local no mesmo path para isolar firmware e servidor.',
              'Preservar logs sanitizados e desfazer apenas a mudança causal confirmada.'
            ]),
            callout('warning', 'Não mascarar com retry agressivo', 'Reconectar mais rápido pode multiplicar carga e piorar o defeito. Primeiro identifique se a origem não envia, o servidor reinicia ou o player encerra.'),
          ],
          ['runbook', 'live', 'fps', 'latência'],
        ),
        article(
          'diagnostico-gravacao',
          'Runbook: falha ou lacuna de gravação',
          'Como preservar evidência e localizar o ponto da falha sem ações destrutivas.',
          ['apps/api/src/recordings', 'apps/api/src/integrity'],
          [
            steps([
              'Não executar limpeza, retenção manual ou reparo sobre o volume antes de preservar evidências.',
              'Confirmar estado desejado da câmera, modo, contrato e horário da lacuna.',
              'Verificar fonte, processo, último TS/MP4 e espaço/inodes do volume.',
              'Comparar arquivos fechados com registros no banco e journal de recuperação.',
              'Inspecionar fila de remux, quarentena, thumbnails e offload.',
              'Se S3 estiver envolvido, verificar marcador no banco e HEAD do objeto sem baixar tudo.',
              'Classificar: origem ausente, captura, fechamento, registro, retenção, offload ou leitura.',
              'Recuperar por fluxo idempotente e documentado; nunca cadastrar/apagar em massa por palpite.'
            ]),
          ],
          ['runbook', 'gravação', 'lacuna'],
        ),
        article(
          'capacidade',
          'Capacidade e limites do servidor',
          'O que dimensiona câmeras ao vivo, gravação e IA e como validar um host.',
          ['docs', 'infra/docker-compose.yml'],
          [
            paragraph('Não existe um número único de câmeras. Passthrough é limitado principalmente por rede, file descriptors e I/O; transcode e IA são limitados por CPU/GPU; playback simultâneo acrescenta egress e leitura; gravação acrescenta IOPS, espaço e fechamento de segmentos.'),
            table(
              ['Carga', 'Gargalo provável'],
              [
                ['RTSP/RTMP passthrough para MediaMTX', 'Rede, sockets, memória e limites de processo.'],
                ['Gravação codec copy', 'Escrita sequencial, espaço e quantidade de arquivos.'],
                ['H.265 para H.264', 'CPU/GPU e latência de agendamento.'],
                ['MOG2', 'CPU, decodificação e quantidade de câmeras analisadas.'],
                ['Detecção avançada', 'Inferência, memória do modelo e acelerador.'],
                ['Playback externo', 'Egress, leitura local/S3 e usuários simultâneos.'],
              ],
            ),
            callout('info', 'Ensaios sintéticos existentes', 'Em um host de referência com 15 vCPU e 27 GiB, testes isolados chegaram a 1.536 streams H.264 passthrough, 200 gravações H.264 copy e cerca de 80 fluxos MOG2 completos. Esses números não são garantia de produção: câmera real, bitrate, GOP, rede, playback, S3 e cargas combinadas mudam o limite.'),
            steps([
              'Definir mix real: codecs, bitrates, perfis, gravação, IA e espectadores.',
              'Gerar fontes sintéticas locais sem acessar câmeras de produção.',
              'Subir carga em degraus e medir primeiro frame, perda, CPU steal, I/O, memória e reconnects.',
              'Executar cargas combinadas e falhas de dependência, não apenas um subsistema isolado.',
              'Definir teto abaixo do primeiro ponto de degradação, mantendo margem de recuperação.'
            ]),
          ],
          ['capacidade', 'benchmark', 'dimensionamento'],
        ),
      ],
    },
    {
      id: 'ciclo-vida',
      title: 'Instalação, atualização e continuidade',
      description: 'Como colocar, atualizar, proteger e recuperar uma instalação.',
      articles: [
        article(
          'instalacao',
          'Provisionamento e instalador seguro',
          'Raiz de confiança, token temporário e artefato imutável.',
          ['apps/central/src/installer-security.js', 'scripts/install-drac.sh'],
          [
            flow([
              'Release aprovada define commit imutável e SHA-256 por canal compatível',
              'Central vincula instalação, artefato e hash confiável',
              'Token temporário autoriza quantidade limitada de downloads',
              'Bootstrap baixa para arquivo temporário, sem curl encadeado ao shell',
              'SHA-256 local é comparado exatamente antes de executar',
              'Arquivo temporário é removido por trap; resultado é auditado',
            ]),
            list([
              'O hash não é confiável se vier do mesmo local mutável que o arquivo sem raiz independente.',
              'Branch móvel nunca identifica o instalador executado.',
              'Ausência ou divergência de hash interrompe antes de qualquer execução.',
              'Token e credencial não aparecem em argv, log ou diagnóstico.',
              'Rollback/compatibilidade pertencem à release vinculada ao artefato.'
            ]),
            callout('danger', 'Privilégio root', 'O instalador altera o host e normalmente precisa de privilégio elevado; por isso a autenticidade do artefato é uma fronteira crítica. Assinatura criptográfica é a evolução natural do SHA-256 ancorado.'),
          ],
          ['instalação', 'sha256', 'supply chain'],
        ),
        article(
          'atualizacao',
          'Atualização e rollback',
          'Uma mudança controlada com preflight, backup e retorno verificável.',
          ['scripts/update-drac.sh', 'infra'],
          [
            steps([
              'Confirmar versão atual, versão alvo, compatibilidade, espaço e saúde das dependências.',
              'Criar e verificar backup compatível antes de alterar estado.',
              'Baixar/verificar artefatos e construir imagens antes da janela crítica quando possível.',
              'Parar escritores de forma ordenada e preservar segmentos em fechamento.',
              'Aplicar migration única e observável.',
              'Subir serviços, aguardar readiness e executar smoke tests de login, live, gravação e playback.',
              'Se falhar, executar rollback documentado compatível com banco e arquivos; não improvisar downgrade.'
            ]),
            callout('warning', 'Banco define o rollback', 'Uma imagem antiga pode não entender uma migration nova. Cada release precisa declarar se o banco é reversível, compatível para frente ou exige restauração.'),
          ],
          ['update', 'rollback', 'migration'],
        ),
        article(
          'backup-restore',
          'Backup e restauração',
          'O que precisa ser protegido e como ensaiar recuperação sem dados reais.',
          ['infra/backup-to-drive.sh', 'infra/offsite-backup.sh', 'infra/verify-postgres-backup.sh', 'scripts/restore-drac.sh', 'apps/api/prisma/schema.prisma'],
          [
            table(
              ['Componente', 'Por que importa'],
              [
                ['PostgreSQL', 'Usuários, câmeras, metadados, permissões, eventos e ponteiros de mídia.'],
                ['Configuração/segredos', 'Permite reconectar serviços; deve ser cifrada e controlada.'],
                ['Gravações locais', 'Conteúdo ainda não enviado ou mantido por política.'],
                ['Objetos S3', 'Conteúdo remoto; backup e versionamento dependem do provedor/política.'],
                ['Chaves de evidência', 'Necessárias para validar material protegido.'],
              ],
            ),
            steps([
              'Verificar formato, versão, checksum e espaço do backup em staging.',
              'Restaurar em ambiente isolado e validar schema/conteúdo antes do cutover.',
              'Parar escritores somente quando o staging estiver pronto.',
              'Trocar dados de forma atômica ou com plano de retorno preservado.',
              'Executar integridade banco-arquivo-S3 e smoke tests.',
              'Guardar relatório do ensaio, RPO alcançado e tempo de recuperação.'
            ]),
            callout('danger', 'Backup não testado é hipótese', 'A existência de um arquivo de dump não prova que segredos, versões, mídia e permissões podem ser recuperados juntos.'),
          ],
          ['backup', 'restore', 'rpo', 'rto'],
        ),
        article(
          'testes-release',
          'Testes e critério de release',
          'Quais verificações protegem cada subsistema antes da publicação.',
          ['package.json', 'pnpm-workspace.yaml', '.github/workflows', 'apps/central/tests'],
          [
            table(
              ['Camada', 'Verificações mínimas'],
              [
                ['API', 'Unitários, integração, e2e, typecheck, Prisma validate e migrations em banco descartável.'],
                ['Web', 'Unitários, typecheck, build e testes de player com cleanup/reconexão.'],
                ['Mobile', 'Unitários/typecheck e cenários de sessão, ciclo de vida e compartilhamento.'],
                ['Central', 'Testes reais do servidor com datastore temporário, autenticação, provisionamento e UI estática.'],
                ['Python IA', 'pytest com mocks/modelos fixtures, concorrência, timeout e recuperação.'],
                ['Go worker', 'go test, go test -race e go vet com versão exigida pelo go.mod.'],
                ['Infra/scripts', 'Compose config, shell syntax/lint, imagens e smoke em ambiente sem dados reais.'],
              ],
            ),
            list([
              'Correção de bug começa por teste que demonstra a falha sempre que viável.',
              'Teste pulado precisa de motivo explícito e dono; skips de produção são dívida visível.',
              'Build aprovado não substitui teste de integração de vídeo, disco e banco.',
              'Release documenta migration, feature flags, compatibilidade, métricas de sucesso e rollback.'
            ]),
          ],
          ['testes', 'ci', 'release'],
        ),
      ],
    },
    {
      id: 'catalogo-funcional',
      title: 'Catálogo completo de módulos',
      description: 'Inventário funcional da API, organização, páginas, configurações e contratos internos.',
      articles: [
        article(
          'inventario-modulos-api',
          'Inventário dos módulos da API',
          'Cada módulo NestJS ativo, sua responsabilidade e a dependência que mais afeta seu funcionamento.',
          ['apps/api/src/app.module.ts', 'apps/api/src'],
          [
            paragraph('AppModule é o mapa oficial de composição da API. A tabela abaixo acompanha todos os módulos ativos importados diretamente e os módulos transversais que eles utilizam.'),
            table(
              ['Módulo', 'Responsabilidade', 'Dependência/falha dominante'],
              [
                ['Prisma', 'Acesso transacional e ciclo da conexão PostgreSQL.', 'Banco indisponível ou migration incompatível.'],
                ['Config', 'Carrega e valida a configuração de ambiente compartilhada pela API.', 'Variável ausente, inválida ou incompatível com o ambiente.'],
                ['Throttler', 'Aplica o limite global de requisições e as exceções declaradas.', 'Identificação incorreta do cliente ou limite incompatível com a carga.'],
                ['AccessControl', 'Centraliza escopo por usuário, papel, grupo e câmera para módulos consumidores.', 'Regra incompleta pode negar acesso legítimo ou ampliar o alcance indevidamente.'],
                ['CommercialPolicy', 'Aplica capacidades comerciais recebidas da Central.', 'Política ausente usa o comportamento conservador definido no serviço.'],
                ['Settings', 'Configurações tipadas, branding e cache curto.', 'Banco indisponível impede ler ou persistir mudança.'],
                ['AppBuilder', 'Configuração e integração para geração do aplicativo móvel.', 'Agente de build ou artefato de saída indisponível.'],
                ['LiveLayouts', 'Layouts pessoais da grade ao vivo.', 'Banco e autorização do proprietário.'],
                ['Gpu', 'Descoberta, autoteste e decisão de aceleração.', 'Driver, runtime ou hardware ausente.'],
                ['RolePermissions', 'Permissões funcionais por papel.', 'Regra persistida e guard de permissão.'],
                ['CloudConnector', 'Heartbeat, licença e configuração enviada pela Central.', 'Central/rede indisponível e revisão ainda não aplicada.'],
                ['CloudStorage', 'Cadastro, teste, seleção e leitura de storages S3.', 'Credencial, endpoint, rede ou bucket.'],
                ['Metrics/Observability', 'Métricas de processo, câmera e Prometheus.', 'Coleta parcial deve aparecer como desconhecida.'],
                ['Health', 'Liveness/readiness e resumo das dependências.', 'Não substitui saúde funcional por câmera.'],
                ['Auth', 'Login, JWT, refresh rotativo, recuperação e revogação.', 'Banco, hash, cookie ou sessão expirada.'],
                ['Users', 'Ciclo de vida de contas e papéis.', 'Autorização administrativa e integridade referencial.'],
                ['Audit', 'Rastro das ações sensíveis.', 'Persistência; falha não deve vazar o payload sensível.'],
                ['Sites', 'Locais físicos de uma instalação.', 'Banco e vínculo com áreas/mapas.'],
                ['Areas', 'Subdivisões físicas dentro de sites.', 'Site inexistente ou referência em uso.'],
                ['SiteMapLayouts', 'Planta/mapa e posicionamento visual das câmeras.', 'Coordenadas, site e permissão.'],
                ['Evidence', 'Preservação, integridade e exportação de evidência.', 'Arquivo, assinatura e fila de exportação.'],
                ['Alarms', 'Regras e ciclo OPEN/ACKED/RESOLVED.', 'Evento de origem e fila de notificação.'],
                ['Notifications', 'Dispositivos push, mutes, entrega e recibos.', 'Provedor externo ou token de dispositivo.'],
                ['Integrity', 'Reconciliação entre registros e mídia.', 'Acesso ao volume/S3 e escopo da varredura.'],
                ['Investigations', 'Casos, bookmarks, itens e legal hold.', 'Autorização e itens de origem.'],
                ['CameraGroups', 'Agrupamento, administração delegada e restrição.', 'Regras de grupo e associação de usuário/câmera.'],
                ['Review', 'Estado de revisão humana de eventos.', 'Evento existente e usuário autorizado.'],
                ['CameraPermissions', 'Delegação VIEW/CONTROL/RECORD/ADMIN.', 'Câmera, destinatário e autoridade de quem concede.'],
                ['Cameras', 'Cadastro, descoberta, perfis, credencial e saúde.', 'Rede da câmera, ONVIF/RTSP e validação SSRF.'],
                ['CameraStream', 'Fonte, tokens de mídia, WebRTC/HLS e gateway.', 'MediaMTX/go2rtc, codec e origem.'],
                ['Ptz', 'Movimento, presets e relés ONVIF.', 'Capacidade do equipamento e timeout.'],
                ['Recordings', 'Processo, catálogo, playback, exportação e retenção.', 'Origem, disco, banco, FFmpeg e storage.'],
                ['Jobs', 'BullMQ, processadores e agendamentos.', 'Redis e idempotência do trabalho.'],
                ['Ai', 'Orquestra MOG2, objetos, faces e QoS.', 'Serviço Python, modelo e política comercial.'],
              ],
            ),
            callout('info', 'Guard global', 'Além dos guards de cada controller, o AppModule aplica rate limiting global. Endpoints públicos são exceções declaradas; autorização de recurso continua sendo obrigatória dentro do fluxo protegido.'),
          ],
          ['api', 'nestjs', 'módulos', 'inventário'],
        ),
        article(
          'sites-areas',
          'Sites e áreas',
          'Hierarquia física da instalação usada para organizar o cadastro de câmeras.',
          ['apps/api/src/sites', 'apps/api/src/areas', 'apps/web/src/pages/CamerasPage.tsx'],
          [
            flow([
              'Administrador cria um site físico',
              'Áreas subdividem o site em setores operacionais',
              'Câmeras são associadas ao contexto físico aplicável',
              'O cadastro e os filtros de Câmeras usam essa hierarquia',
            ]),
            table(
              ['Entidade', 'Função', 'Regra de integridade'],
              [
                ['Site', 'Unidade, prédio ou local monitorado.', 'Não remover silenciosamente enquanto áreas dependem dele.'],
                ['Area', 'Setor dentro do site.', 'Pertence a um site e usa IDs validados.'],
                ['Camera', 'Ponto de vídeo associado ao site/área.', 'A hierarquia não concede acesso; só organiza o inventário.'],
              ],
            ),
            callout('info', 'A planta saiu', 'A tela de Mapa/Planta foi removida em 07/08/2026. O módulo SiteMapLayout da API continua no código sem nenhum cliente — remover exige migração de banco e é decisão em aberto.'),
            callout('warning', 'Hierarquia não é permissão', 'Conhecer o site ou o ID de uma câmera não libera live, playback ou PTZ. Cada ação repete a autorização do recurso.'),
          ],
          ['site', 'área', 'hierarquia'],
        ),
        article(
          'layouts-grade-wall',
          'Layouts de live, grade e modo parede',
          'Persistência da organização visual sem transformar preferência em regra de acesso.',
          ['apps/api/src/live-layouts', 'apps/web/src/pages/LiveViewPage.tsx', 'apps/web/src/pages/WallModePage.tsx', 'apps/web/src/store/gridStore.ts'],
          [
            paragraph('LiveLayout guarda a composição escolhida pelo usuário: nome, células, câmeras, ordem e preferências compatíveis. A grade ativa pode existir apenas no estado do cliente enquanto um layout salvo permite retomada posterior.'),
            list([
              'A API filtra ou recusa câmeras que deixaram de ser acessíveis, mesmo que o ID continue no layout salvo.',
              'Mudar quantidade de células não inicia fontes sem demanda; cada player cria e libera sua própria sessão.',
              'Modo parede privilegia leitura e estabilidade, não concede controles administrativos.',
              'Qualidade da grade pode usar substream e a câmera destacada pode usar perfil superior.',
              'Ao sair da tela, cada player encerra timers, leases e conexões para evitar consumo invisível.'
            ]),
            callout('info', 'Layout é preferência', 'Layout salvo não representa estado da câmera nem prova de disponibilidade. Célula vazia, câmera removida ou permissão revogada precisam degradar sem quebrar o restante da grade.'),
          ],
          ['layout', 'grade', 'wall', 'live'],
        ),
        article(
          'usuarios-grupos-permissoes',
          'Usuários, grupos, papéis e delegação',
          'Como a autorização global e por câmera se combina.',
          ['apps/api/src/users', 'apps/api/src/camera-groups', 'apps/api/src/camera-permissions', 'apps/api/src/role-permissions', 'apps/web/src/pages/UsersPage.tsx', 'apps/web/src/pages/GroupsPage.tsx', 'apps/web/src/pages/RolesPage.tsx'],
          [
            table(
              ['Camada', 'Exemplo de decisão', 'Autoridade'],
              [
                ['Papel', 'VIEWER, OPERATOR, ADMIN ou SUPER_ADMIN.', 'Cadastro do usuário e guards de role.'],
                ['Permissão funcional', 'serverConfig, usuários, exportação ou função equivalente.', 'RolePermission e PermissionsGuard.'],
                ['Grupo de câmera', 'Conjunto administrado e situação ACTIVE/RESTRICTED/SUSPENDED.', 'CameraGroup e regra do grupo.'],
                ['Permissão individual', 'VIEW, CONTROL, RECORD ou ADMIN numa câmera.', 'CameraPermission e quem pode delegar.'],
                ['Propriedade privada', 'Conteúdo visível ao dono e delegados.', 'Owner da câmera e AccessControl.'],
                ['Política comercial', 'Capacidade liberada para a instalação.', 'CommercialPolicy após heartbeat da Central.'],
              ],
            ),
            paragraph('A decisão efetiva é a interseção das camadas. Ter papel administrativo não deve contornar automaticamente o conteúdo privado; ter VIEW não libera CONTROL; e a Central não substitui as permissões locais.'),
            list([
              'Criar, bloquear, excluir ou trocar papel exige ator autorizado e auditoria.',
              'Troca de senha revoga sessões; mudança de autorização passa a valer nas consultas seguintes.',
              'Grupo restrito pode limitar histórico; todos os endpoints derivados precisam aplicar a mesma regra.',
              'Delegação nunca pode conceder nível superior ao que o ator pode administrar.',
              'Listagens e acessos diretos por ID usam o mesmo conjunto efetivo de recursos.'
            ]),
          ],
          ['usuário', 'grupo', 'papel', 'permissão'],
        ),
        article(
          'eventos-revisao-investigacao',
          'Eventos, revisão, alarmes e investigação',
          'Diferença entre detecção automática, decisão humana, ocorrência e caso preservado.',
          ['apps/api/src/review', 'apps/api/src/alarms', 'apps/api/src/evidence', 'apps/api/src/investigations', 'apps/web/src/pages/ReviewPage.tsx', 'apps/web/src/pages/AlarmsPage.tsx', 'apps/web/src/pages/InvestigationPage.tsx'],
          [
            table(
              ['Objeto', 'Nasce quando', 'Termina/é preservado quando'],
              [
                ['CameraEvent', 'Movimento, IA ou integração produz um evento.', 'Segue sua retenção e vínculos.'],
                ['UserEventReview', 'Usuário classifica ou marca o evento.', 'Mantém autoria e estado de revisão.'],
                ['AlarmInstance', 'Uma regra transforma o sinal em ocorrência.', 'Passa por OPEN, ACKED e RESOLVED.'],
                ['Evidence', 'Material é explicitamente preservado.', 'Expira ou é removido por fluxo autorizado.'],
                ['Investigation', 'Pessoa abre um caso e agrega itens/bookmarks.', 'Lifecycle do caso; itens protegidos não entram na limpeza comum.'],
              ],
            ),
            flow([
              'Detecção gera evento',
              'Regra opcional gera alarme',
              'Notificação tenta alcançar destinatários',
              'Operador revisa e reconhece',
              'Material relevante entra em evidência/investigação',
              'Retenção respeita a proteção ativa',
            ]),
            callout('warning', 'Estados independentes', 'Falha de push não resolve o alarme; revisão humana não apaga o evento; exportar um clip não preserva automaticamente a gravação original sem vínculo de evidência/legal hold.'),
          ],
          ['evento', 'review', 'alarme', 'investigação'],
        ),
        article(
          'catalogo-configuracoes',
          'Catálogo de configurações persistidas',
          'Chaves administráveis, limites e efeito real no runtime da instalação.',
          ['apps/api/src/settings/settings.service.ts', 'apps/api/src/settings/settings.controller.ts', 'apps/web/src/pages/SettingsPage.tsx'],
          [
            table(
              ['Configuração', 'Padrão/faixa', 'Efeito'],
              [
                ['facilityName', 'Nome textual não vazio.', 'Nome da instalação e branding.'],
                ['defaultRetentionDays', '7; mínimo 1, máximo 365.', 'Padrão aplicado ao cadastro/política de retenção.'],
                ['autoCleanupEnabled', 'Ligado.', 'Autoriza a rotina automática de limpeza.'],
                ['sessionTimeoutMinutes', '480; 5 a 1440.', 'Tempo de sessão configurável.'],
                ['maxLoginAttempts', '5; 3 a 20.', 'Limiar de proteção de login.'],
                ['requireStrongPassword', 'Ligado.', 'Política de senha na criação/alteração.'],
                ['alarmAudioEnabled', 'Ligado.', 'Preferência global do alerta sonoro.'],
                ['gpuAccelerationEnabled', 'Desligado.', 'Transcode FFmpeg por GPU somente após autoteste.'],
                ['aiFeatureEnabled', 'Desligado.', 'Ativa a superfície e orquestração de IA.'],
                ['gpuAiAccelerationEnabled', 'Desligado.', 'ONNX Runtime/CUDA quando IA e infraestrutura permitem.'],
                ['brandUseDefaultColors', 'Ligado.', 'Mantém paleta padrão sem apagar as cores personalizadas armazenadas.'],
                ['brandLogoDataUrl', 'Vazio; imagem limitada.', 'Logo no login e superfícies de marca.'],
                ['brand*Color', 'Vazio ou #RRGGBB.', 'Paletas escura e clara, texto, menu, borda e estados.'],
              ],
            ),
            list([
              'Somente chaves presentes no catálogo do servidor são aceitas; chave desconhecida não ganha efeito por acidente.',
              'Números são arredondados e limitados à faixa; cores exigem #RRGGBB; imagem exige data:image e teto de tamanho.',
              'O branding público é um subconjunto necessário para a tela de login e nunca inclui segredo operacional.',
              'Atualização completa exige ADMIN, permissão serverConfig e evento de auditoria.',
              'Cache de configurações é curto; patch invalida o cache para a próxima leitura.'
            ]),
          ],
          ['settings', 'configuração', 'branding', 'defaults'],
        ),
        article(
          'contratos-internos',
          'Contratos entre serviços internos',
          'Chamadas que atravessam API, IA, worker, mídia e Central sem virar API pública.',
          ['apps/api/src/ai/ai.service.ts', 'apps/api/src/recordings/recordings.controller.ts', 'apps/api/src/camera-stream/camera-stream.controller.ts', 'services/ai-service-python/main.py', 'services/camera-worker-go/main.go'],
          [
            table(
              ['Origem → destino', 'Finalidade', 'Proteção/limite'],
              [
                ['API → IA Python', 'Iniciar/parar processador, QoS, saúde e confirmação.', 'X-Service-Token forte, timeout e rede interna.'],
                ['IA → API', 'Eventos/detecções e estado quando o contrato exigir callback.', 'Token interno, payload limitado e câmera conhecida.'],
                ['API → MediaMTX', 'Criar/consultar paths e autorizar playback/publicação.', 'Callback interno e token curto vinculado ao recurso.'],
                ['Worker Go → API', 'Listar câmera autorizada e registrar segmento.', 'X-Service-Token, timeout e modo worker exclusivo.'],
                ['API → Redis', 'Comandos de worker e jobs BullMQ.', 'Canal/fila definidos, retry limitado e idempotência.'],
                ['Instalação → Central', 'Heartbeat, métricas, revisão aplicada e licença.', 'ID + chave de licença, timeout e payload sanitizado.'],
                ['Central → build-agent', 'Gerar artefatos white-label.', 'Token compartilhado, timeout e limite de resposta.'],
              ],
            ),
            callout('danger', 'Token interno não é login humano', 'Credencial de serviço tem escopo de rede e função. Ela não deve ser aceita como sessão de usuário, aparecer no navegador ou ser reutilizada entre ambientes.'),
          ],
          ['contrato', 'serviço interno', 'token', 'timeout'],
        ),
        article(
          'matriz-paginas-web',
          'Matriz de páginas e papéis da aplicação web',
          'Rotas ativas e o papel mínimo usado pela navegação local.',
          ['apps/web/src/App.tsx', 'apps/web/src/layouts/AppLayout.tsx', 'apps/web/src/pages'],
          [
            table(
              ['Rota', 'Papel mínimo na UI', 'Função'],
              [
                ['/live', 'VIEWER', 'Grade e visualização ao vivo.'],
                ['/playback', 'VIEWER', 'Histórico e linha do tempo.'],
                ['/review', 'VIEWER', 'Revisão humana de eventos acessíveis.'],
                ['/ptz', 'VIEWER na rota; permissão de controle no recurso.', 'PTZ/presets autorizados.'],
                ['/wall', 'VIEWER', 'Monitor de parede.'],
                ['/profile', 'VIEWER', 'Perfil, grupos e ações delegadas.'],
                ['/cameras e /cameras/:id', 'OPERATOR', 'Inventário, cadastro e detalhe.'],
                ['/alarms', 'OPERATOR', 'Fila e lifecycle de alarmes.'],
                ['/investigation', 'OPERATOR', 'Casos, itens e bookmarks.'],
                ['/storage', 'OPERATOR', 'Disco, nuvem, retenção e saúde.'],
                ['/users', 'OPERATOR', 'Usuários conforme permissões efetivas.'],
                ['/settings', 'ADMIN', 'Configuração geral, IA, GPU e branding.'],
                ['/groups', 'ADMIN', 'Grupos e administração delegada.'],
                ['/roles', 'ADMIN', 'Permissões funcionais por papel.'],
              ],
            ),
            callout('warning', 'A matriz da UI é navegação', 'O papel mínimo da rota não substitui guards, permissões funcionais ou escopo por câmera na API. PTZ é o exemplo: abrir a página não autoriza controlar qualquer câmera.'),
          ],
          ['web', 'rotas', 'papéis', 'páginas'],
        ),
      ],
    },
    {
      id: 'plataforma-avancada',
      title: 'Plataforma, Central e componentes especiais',
      description: 'Heartbeat, datastore, scheduler, worker legado, GPU, mídia, build e variáveis operacionais.',
      articles: [
        article(
          'cloud-connector-heartbeat',
          'Cloud Connector e heartbeat',
          'Sincronização outbound da instalação, revisão de configuração e degradação quando a Central some.',
          ['apps/api/src/cloud-connector/cloud-connector.service.ts', 'apps/api/src/cloud-connector/heartbeat-cameras.helper.ts', 'apps/central/src/server.js'],
          [
            flow([
              'Instalação espera o primeiro ciclo e coleta resumo sanitizado',
              'POST outbound envia identidade, licença, versão, saúde e revisão aplicada',
              'Central autentica, persiste heartbeat e calcula política/configuração desejada',
              'Instalação normaliza licença, restrições, storage e revisão',
              'Runtime aplica restrições; somente depois grava APPLIED e a revisão',
              'Próximo heartbeat confirma à Central o resultado real',
            ]),
            keyValue([
              ['Primeiro ciclo', 'Aproximadamente cinco segundos depois da subida quando habilitado.'],
              ['Intervalo', 'Configurável; padrão 60 segundos e mínimo defensivo de 15 segundos.'],
              ['Timeout HTTP', 'Configurável; padrão operacional de oito segundos.'],
              ['Concorrência', 'Um sync por vez; ciclo sobreposto é ignorado.'],
              ['Estado persistido', 'Último sync/erro, licença, restrições, storage, revisão e resultado da aplicação.'],
              ['Falha da Central', 'Registra erro sanitizado e tenta no próximo ciclo sem apagar a configuração local válida.'],
            ]),
            list([
              'O heartbeat não abre porta de entrada na instalação; a conexão parte do cliente.',
              'Payload de câmera pode ser limitado/truncado, mantendo totais para não mentir sobre a frota.',
              'Storage disabled significa pausa; absent significa remoção. A instalação reage de forma diferente.',
              'A revisão só é confirmada depois da aplicação; falha permanece visível como FAILED.',
              'Credencial da licença vai em header de serviço e nunca entra no resumo público ou log.'
            ]),
          ],
          ['cloud connector', 'heartbeat', 'revisão', 'central'],
        ),
        article(
          'infra-midia-proxy',
          'MediaMTX, go2rtc, Nginx e redes',
          'Papéis dos componentes de borda e por que suas portas não são equivalentes.',
          ['infra/mediamtx.yml', 'infra/go2rtc.yml', 'infra/ajustcam.nginx.conf', 'infra/reverse-proxy.nginx.example', 'infra/docker-compose.yml'],
          [
            table(
              ['Componente', 'Entrada/saída principal', 'Regra de exposição'],
              [
                ['Nginx AjustCam', 'HTTP(S) do web, API e mídia encaminhada.', 'É a borda pública preferencial; aplica limites, headers e timeouts.'],
                ['MediaMTX', 'RTSP/RTMP ingest e WebRTC/HLS/RTSP delivery.', 'Admin/callback e portas internas ficam restritos; publicação/leitura passam por auth.'],
                ['go2rtc', 'Ponte de protocolos e streams auxiliares.', 'Somente rede de serviços, salvo necessidade expressa e protegida.'],
                ['RTMP ingest adicional', 'Configurações SRS/Nginx quando usadas.', 'Path e credencial de publicação são limitados à câmera.'],
                ['PostgreSQL/Redis', 'Estado e filas.', 'Nunca expostos diretamente à Internet.'],
                ['Serviço de IA', 'HTTP interno e captura de stream.', 'Token de serviço + rede interna; health não vira controle público.'],
              ],
            ),
            list([
              'CORS não substitui autenticação; cliente não-browser ignora CORS.',
              'depends_on não prova readiness; cada consumidor precisa de timeout e reconexão.',
              'Proxy deve preservar Range no playback e os requisitos de upgrade/sinalização do WebRTC.',
              'Timeout de proxy para live não pode encerrar sessões longas como uma requisição comum.',
              'Volumes de gravação, banco e segredos usam montagem mínima e permissões específicas.',
              'A API administrativa do MediaMTX não deve ficar publicamente acessível.'
            ]),
          ],
          ['mediamtx', 'go2rtc', 'nginx', 'rede'],
        ),
        article(
          'worker-go-legado',
          'Worker Go de câmera e gravação',
          'Quando pode rodar, como se comunica e por que não é o pipeline canônico.',
          ['services/camera-worker-go/main.go', 'services/camera-worker-go/recorder.go', 'services/camera-worker-go/secret_input.go', 'services/camera-worker-go/go.mod', 'infra/docker-compose.yml'],
          [
            paragraph('O worker Go contém implementação funcional, apesar do README legado ainda chamá-lo de placeholder. Ele é mantido para compatibilidade histórica e só pode rodar no profile legacy-worker com RECORDING_CONTROL_MODE=worker na API e no worker.'),
            flow([
              'Inicialização exige chaves internas fortes e modo worker explícito',
              'Conecta ao Redis e assina canal de comandos',
              'Consulta periodicamente câmeras por endpoint interno',
              'Inicia ou para loop conforme enabled + recordingEnabled',
              'FFmpeg gera MP4 e worker registra metadados na API',
              'Sinal/cancelamento encerra gravações, Redis e health server',
            ]),
            table(
              ['Aspecto', 'Worker Go', 'Pipeline canônico da API'],
              [
                ['Codec', 'Transcode H.264 baseline/ultrafast.', 'Copy da origem quando possível.'],
                ['Custo', 'CPU contínua e perda de qualidade.', 'Custo baixo em copy; remux após fechamento.'],
                ['Contêiner', 'MP4 produzido diretamente.', 'TS durante captura, MP4 validado após remux.'],
                ['Uso recomendado', 'Compatibilidade explícita e controlada.', 'Produção padrão.'],
              ],
            ),
            callout('danger', 'Exclusividade obrigatória', 'Subir API em modo local e worker ao mesmo tempo duplicaria conexão, CPU, disco e registros. O worker recusa iniciar fora do modo worker para tornar esse erro visível.'),
          ],
          ['go', 'worker', 'legado', 'gravação'],
        ),
        article(
          'gpu-aceleracao',
          'GPU, transcode e aceleração de IA',
          'Do autoteste à decisão por workload, sem assumir que GPU presente é GPU utilizável.',
          ['apps/api/src/gpu', 'apps/api/src/recordings/helpers/ffmpeg-priority.helper.ts', 'infra/docker-compose.gpu.yml', 'infra/gpu-setup.sh', 'services/ai-service-python/onnxruntime_session.py'],
          [
            table(
              ['Capacidade', 'Ativação', 'Fallback'],
              [
                ['Transcode FFmpeg', 'gpuAccelerationEnabled após descoberta/autoteste.', 'Codec por CPU ou recusa controlada conforme o fluxo.'],
                ['IA ONNX Runtime', 'aiFeatureEnabled + gpuAiAccelerationEnabled + runtime compatível.', 'Provider CPU quando suportado; saúde informa degradação.'],
                ['OpenVINO', 'Modelo/dispositivo disponível no serviço Python.', 'CPU/OpenVINO compatível ou detector indisponível.'],
                ['Decodificação', 'Depende de driver, imagem e codec.', 'Software com impacto mensurável de CPU.'],
              ],
            ),
            steps([
              'Detectar dispositivo, driver e runtime no mesmo container que executará o workload.',
              'Executar autoteste curto com codec/modelo representativo.',
              'Somente depois persistir a flag de aceleração.',
              'Expor provider realmente escolhido e falha de inicialização nas métricas.',
              'Medir throughput e latência sob carga combinada; presença de GPU não define capacidade sozinha.'
            ]),
            callout('warning', 'Dois interruptores', 'Aceleração de vídeo e aceleração de IA são configurações diferentes. Ligar uma não prova que a outra imagem, biblioteca ou modelo está preparado.'),
          ],
          ['gpu', 'nvenc', 'onnxruntime', 'openvino'],
        ),
        article(
          'central-datastore',
          'Datastore, concorrência e histórico da Central',
          'JSON, dual-read, PostgreSQL, locks, migração e série temporal.',
          ['apps/central/src/datastore/index.js', 'apps/central/src/datastore/pg-store.js', 'apps/central/src/datastore/singleton-lock.js', 'apps/central/src/datastore/timeseries.js', 'apps/central/src/datastore/signing-backup.js'],
          [
            table(
              ['Modo', 'Leitura', 'Escrita', 'Uso'],
              [
                ['json', 'Arquivo JSON.', 'Arquivo com serialização, substituição atômica e backup.', 'Padrão sem URL PostgreSQL; uma instância por lock.'],
                ['dual', 'PostgreSQL com fallback para JSON legado.', 'Somente PostgreSQL.', 'Janela de migração/rollback; padrão quando URL específica existe.'],
                ['pg', 'Somente PostgreSQL.', 'Somente PostgreSQL.', 'Estado final depois da validação do cutover.'],
              ],
            ),
            list([
              'Somente DRAC_CENTRAL_DATABASE_URL ativa o banco da Central; DATABASE_URL genérico é ignorado.',
              'Antes do backfill, a migração grava backup durável das identidades de assinatura sem segredo em claro.',
              'PostgreSQL usa advisory lock exclusivo para impedir dois escritores da Central.',
              'JSON usa lock de instância; duas Centrais no mesmo arquivo são recusadas.',
              'Série temporal longa só fica ativa com PostgreSQL; o JSON mantém histórico curto para não crescer a cada heartbeat.',
              'Raw é consolidado em agregados horários e ambos têm retenção configurada.'
            ]),
            callout('danger', 'Rollback do datastore', 'Durante dual-read, o JSON é uma fonte legada somente leitura. Reescrevê-lo em paralelo destruiria a janela de rollback e poderia ressuscitar estado antigo.'),
          ],
          ['central', 'postgresql', 'json', 'dual-read'],
        ),
        article(
          'scheduler-multinode',
          'Scheduler multi-nó e fencing',
          'Planejamento determinístico, capacidade, leases, failover e drenagem.',
          ['apps/central/src/scheduler/config.js', 'apps/central/src/scheduler/plan.js', 'apps/central/src/scheduler/leases.js', 'apps/central/src/datastore/compute-nodes.js'],
          [
            paragraph('O scheduler atual planeja atribuições; não executa carga remotamente por si só. As rotas existem por padrão salvo disjuntor de ambiente explícito, enquanto cada instalação nasce com schedulerEnabled desligado e só entra no plano por decisão do operador.'),
            keyValue([
              ['Lease padrão', '120 segundos.'],
              ['Nó morto', 'Sem heartbeat por 180 segundos ou status down explícito.'],
              ['Capacidade implícita', '16 cargas ponderadas para nó sem capacidade declarada.'],
              ['Drenagem', 'Uma carga por replanejamento e por nó, configurável; zero congela.'],
              ['Teto de workloads', '5.000 para proteger datastore e tempo de cálculo.'],
              ['Determinismo', 'Mesma entrada e mesmo now produzem o mesmo plano.'],
            ]),
            list([
              'Preserva atribuições saudáveis para evitar migração desnecessária quando um nó novo entra.',
              'Cargas excedentes ficam unassigned; capacidade nunca é tratada como infinita.',
              'Failover tem prioridade sobre drenagem programada.',
              'Fencing token impede nó antigo/zumbi de continuar dono depois da troca.',
              'Lease expirado é recusado mesmo com nodeId e token anteriormente corretos.',
              'Dry-run calcula sem persistir e serve para avaliar impacto antes da mudança.'
            ]),
          ],
          ['scheduler', 'compute node', 'lease', 'fencing'],
        ),
        article(
          'app-builder-white-label',
          'App Builder, white-label e artefatos Android',
          'Como a marca da instalação vira APK/AAB sem expor credenciais ao navegador.',
          ['apps/mobile/scripts/build-agent.mjs', 'apps/mobile/scripts/build-client.sh', 'apps/mobile/app.config.js', 'apps/central/src/server.js'],
          [
            flow([
              'Administrador define nome, packageId, servidor e identidade visual',
              'Central/API prepara configuração sanitizada do cliente',
              'Build-agent autenticado recebe o trabalho com timeout e limite de resposta',
              'Expo/Gradle gera APK, AAB e kit de publicação',
              'Central acompanha estado e entrega artefato por rota autenticada',
            ]),
            list([
              'packageId é identidade permanente na loja e deve ser decidido antes da primeira publicação.',
              'Keystore e senha de assinatura não entram no frontend, log ou pacote de documentação.',
              'Editar nome/servidor preserva preferências mesmo quando um build publicado é removido.',
              'Build é assíncrono; queued/building/done/failed são estados observáveis.',
              'Download administrativo valida cliente/slug e não confia em caminho fornecido pelo navegador.',
              'Branding usa apenas chaves permitidas e mantém paletas clara/escura compatíveis.'
            ]),
            callout('warning', 'Assinatura define continuidade', 'Perder a chave de assinatura impede atualizar o mesmo aplicativo instalado/publicado. Backup do keystore é parte da continuidade do produto, não um detalhe do build.'),
          ],
          ['apk', 'aab', 'white-label', 'build-agent'],
        ),
        article(
          'variaveis-feature-flags',
          'Variáveis de ambiente e feature flags',
          'Mapa das famílias de configuração e a fronteira entre implantação e regra persistida.',
          ['apps/api/src/config/env.config.ts', 'infra/.env.example', 'infra/.env.prod.example', 'infra/docker-compose.yml', 'apps/central/src/server.js'],
          [
            table(
              ['Família', 'Exemplos de responsabilidade', 'Regra'],
              [
                ['Banco/Redis', 'URLs, pool, timeouts e fila.', 'Segredo de implantação; mudança exige readiness e ensaio.'],
                ['JWT/cookies/serviço', 'Assinatura, TTL, cookie e tokens internos.', 'Nunca usar placeholder; rotação possui impacto de sessão/serviço.'],
                ['Câmera/mídia', 'MediaMTX, go2rtc, transports, paths e timeouts.', 'Endpoint interno e limites são compatíveis com o Compose.'],
                ['Gravação', 'Raiz, segmento, auto-start, controle local/worker, disco e restart.', 'Estado desejado continua no banco; env define capacidade do processo.'],
                ['IA/GPU', 'URL de serviço, token, watchdog, modelos e provider.', 'Feature desligada não deve deixar processador órfão.'],
                ['Nuvem', 'Connector, instalação, heartbeat e S3 provisionado.', 'Credenciais não são documentação nem valor público.'],
                ['Central', 'Sessão, proxy, datastore, instalador, scheduler e build-agent.', 'Variáveis específicas evitam herdar configuração da API por acidente.'],
                ['Retenção/offload', 'Batch, concorrência, janela local e agendamento.', 'Banco guarda política; env fornece limites defensivos.'],
                ['Observabilidade', 'Métricas, logs, histórico e manutenção.', 'Ausência deve ser desconhecida, nunca zero inventado.'],
              ],
            ),
            list([
              'Arquivo .env real nunca é exibido ou copiado para diagnósticos; use somente exemplos versionados.',
              'Feature flag define disponibilidade técnica; permissão e licença continuam sendo decisões separadas.',
              'Default seguro não inicia transcode, IA pesada, scheduler por instalação ou offload sem decisão explícita.',
              'Alterar uma flag em apenas um serviço pode quebrar contratos, como RECORDING_CONTROL_MODE entre API e worker.',
              'Toda release deve registrar flags adicionadas/removidas, default, compatibilidade e forma de rollback.'
            ]),
            callout('info', 'Fonte de verdade', 'Este artigo explica famílias e efeitos. Nomes, defaults e validações exatas continuam tendo como autoridade env.config.ts, SettingsService e os módulos consumidores da mesma versão.'),
          ],
          ['env', 'feature flag', 'configuração', 'implantação'],
        ),
      ],
    },
    {
      id: 'referencia',
      title: 'Referência rápida',
      description: 'Glossário, estados e checklists para consulta diária.',
      articles: [
        article(
          'glossario',
          'Glossário do AjustCam',
          'Termos usados no código, na operação e na infraestrutura de vídeo.',
          [],
          [
            table(
              ['Termo', 'Significado'],
              [
                ['VMS', 'Sistema de gerenciamento de vídeo.'],
                ['RTSP', 'Protocolo comum para a plataforma puxar áudio/vídeo da câmera.'],
                ['RTMP push', 'Modo em que a câmera publica o stream para o servidor.'],
                ['ONVIF', 'Padrão de descoberta, perfis, PTZ e eventos de câmeras IP.'],
                ['MediaMTX', 'Servidor de mídia que recebe fontes e entrega protocolos de visualização.'],
                ['go2rtc', 'Ponte/normalizador de protocolos e codecs em fluxos específicos.'],
                ['WHEP', 'Sinalização HTTP para receber WebRTC com baixa latência.'],
                ['HLS/LL-HLS', 'Entrega HTTP segmentada; compatível e geralmente mais latente que WebRTC.'],
                ['GOP/keyframe', 'Estrutura de quadros que influencia início da reprodução e busca.'],
                ['Remux', 'Troca de contêiner sem recodificar o vídeo.'],
                ['Transcode', 'Decodifica e recodifica; consome CPU/GPU e pode alterar qualidade.'],
                ['MOG2', 'Modelo estatístico de fundo para detectar movimento, não classe de objeto.'],
                ['Offload', 'Envio de gravação fechada para storage remoto.'],
                ['RPO/RTO', 'Perda máxima aceitável de dados e tempo-alvo de recuperação.'],
                ['Lease', 'Registro temporário de que um consumidor ainda usa um recurso.'],
                ['Idempotência', 'Repetir uma operação produz o mesmo estado sem duplicação ou dano.'],
              ],
            ),
          ],
          ['glossário', 'termos'],
        ),
        article(
          'estados',
          'Estados que não devem ser confundidos',
          'Desejo, observação, contrato, saúde e processamento.',
          [],
          [
            table(
              ['Estado', 'Exemplo', 'Não significa'],
              [
                ['Desejado', 'recordingEnabled=true', 'Que FFmpeg está gravando agora.'],
                ['Observado', 'Último frame há 2 s', 'Que a câmera continuará saudável.'],
                ['Transporte', 'RTMP publish aceito', 'Que um único frame foi recebido.'],
                ['Comercial', 'RESTRICTED', 'Que o grupo interno também está restrito.'],
                ['Job', 'completed', 'Que o efeito externo foi confirmado, salvo se o job o verificou.'],
                ['Upload', 'PUT respondeu', 'Que o banco persistiu a origem e já pode apagar local.'],
                ['Arquivo', 'MP4 existe', 'Que foi fechado, validado e registrado.'],
                ['IA', 'Serviço vivo', 'Que captura e inferência de cada câmera estão saudáveis.'],
              ],
            ),
          ],
          ['estado', 'consistência'],
        ),
        article(
          'checklist-incidente',
          'Checklist de incidente',
          'Preservar fatos, reduzir impacto e evitar que o diagnóstico piore o problema.',
          [],
          [
            steps([
              'Registrar início, impacto, instalações/câmeras afetadas e última mudança conhecida.',
              'Escolher um coordenador e impedir mudanças concorrentes não registradas.',
              'Preservar logs e métricas sanitizados; nunca copiar segredos.',
              'Verificar capacidade, dependências e saúde antes de reiniciar serviços.',
              'Mitigar pelo menor escopo reversível e observar métricas de sucesso.',
              'Validar live, gravação, playback e integridade após a mitigação.',
              'Documentar causa confirmada, evidência, correção definitiva e teste de regressão.'
            ]),
            callout('danger', 'Ações proibidas por padrão', 'Não execute limpeza, restauração, migration, remoção de volume ou reinício em massa durante diagnóstico sem alvo confirmado, backup aplicável e autorização operacional.'),
          ],
          ['incidente', 'checklist'],
        ),
      ],
    },
  ],
};

module.exports = {
  TECHNICAL_DOCUMENTATION,
  TECHNICAL_DOCUMENTATION_PERMISSION,
};
