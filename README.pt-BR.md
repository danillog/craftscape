# Craftscape

[English](README.md) · **Português**

Um planeta nas suas mãos, no navegador. Duas versões no mesmo projeto:

- **3D** (`/`): esculpa rocha, solo e areia, jogue água e veja chuva, rios, erosão, clima e
  vegetação mudarem a paisagem. A simulação inteira roda na GPU via **WebGPU**.
- **2D** (`/2d.html`): o planeta inteiro visto de cima, simulado na CPU. Tem placas tectônicas
  que andam, clima com estações e povos que nascem, navegam, guerreiam e chegam à era
  moderna. É um jogo de deus, e roda em qualquer navegador, sem GPU.

Sem WebGPU (ou com WebGPU só por software, que travaria o computador), a página 3D abre a 2D
sozinha.

É uma reescrita do [Craftscape original](https://github.com/pyalot/craftscape) de
Florian Boesch (2011, WebGL1 + jQuery). A física da água, da erosão e o visual do 3D são ports
dos shaders originais para WGSL; o resto (engine, câmera, interface, clima, povos e toda a
versão 2D) foi escrito do zero.

## Rodando

```sh
npm install
npm run dev      # http://localhost:5173 (3D) e http://localhost:5173/2d.html (2D)
npm run build    # gera dist/ (site estático, as duas páginas)
npm run lint
```

O 3D precisa de um navegador com WebGPU. No **Chrome para Linux** ele vem desligado: ative
`chrome://flags/#enable-unsafe-webgpu` e `chrome://flags/#enable-vulkan` e reinicie o
navegador. Sem GPU de verdade, o 3D redireciona para o 2D; para insistir no 3D mesmo assim
(com WebGPU por software, bem lento), abra `/?3d`.

### Publicando (Hostinger)

O site fica em `danillogomes.com/craftscape/` (o `base` do Vite é `/craftscape/` no build).
Para publicar:

1. Copie `.env.deploy.example` para `.env.deploy` e preencha com os dados de SSH do hPanel.
   O `.env.deploy` fica fora do git.
2. Rode `npm run deploy`. Ele faz o build e envia `dist/` por rsync via SSH.

Uma trava recusa qualquer `DEPLOY_PATH` que não termine em `/craftscape/`, porque o rsync
apaga o que sobra no destino.

## Craftscape 2D

Código em `src/tiles/`. O mapa é o **planeta inteiro**, em projeção equiretangular: polo norte
em cima, equador no meio, polo sul embaixo, 360° de longitude de ponta a ponta. Os tamanhos
vão de 128² a 384² tiles; acima de 256² fica pesado.

**Clima.** A temperatura vem da latitude (cerca de 27 °C no equador e −23 °C nos polos) e da
altitude (−6,5 °C por km). Também esquentam o ar o calor de lava, fogo e cidades, as
estações e o ciclo do dia.

- **Sombra da Terra:** a altura do sol em cada ponto é a da geometria real (latitude,
  declinação, hora). Por isso a noite é uma curva que muda com as estações, com sol da
  meia-noite e noite polar.
- **Ventos:** as faixas do planeta (alísios, ventos de oeste, polares) mais os sistemas de alta
  e baixa pressão. As baixas giram pelo efeito de Coriolis: anti-horário no norte, horário no
  sul, quase nada no equador.
- **Cinturões de pressão:** baixa equatorial, altas subtropicais (os desertos), baixas
  subpolares e altas polares. Eles seguem o sol, e há monções sobre os continentes.
- **Chuva:** o vapor viaja com o vento e chove quando passa da saturação, ao subir encostas, por
  convecção e no centro das baixas. Rios se formam por acúmulo de fluxo. Vegetação, neve, gelo
  e areia seguem o clima.

**Placas tectônicas.** As placas nascem da terra: cada continente é uma placa, e as placas
oceânicas preenchem os mares. Elas andam de verdade, tile a tile, levando relevo, rios,
florestas e cidades.

- **Colisões:** onde duas placas se encontram, a crosta oceânica mergulha (fossa e arco
  vulcânico) ou dois continentes se empilham numa cordilheira.
- **Riftes:** onde se afastam, abre-se assoalho oceânico novo, raso na dorsal e cada vez mais
  fundo ao envelhecer. Continentes se partem em riftes e se juntam de novo, num ciclo como o
  da Pangeia.
- **Terremotos e vulcões** nas bordas, com tsunamis quando acontecem no mar.

**Povos** (`src/engine/life.ts`, compartilhado com o 3D):

- **Crescimento:** cidades crescem, fundam colônias (também por mar) e avançam pelas eras até
  a Moderna.
- **Contato entre povos:** trocam saber pelo comércio, pegam palavras emprestadas dos
  vizinhos (as línguas formam famílias), espalham a fé e guerreiram, até uma guerra nuclear.
- **Na terra:** marcas reversíveis (lavouras, desmatamento, cidades, represas, fumaça
  industrial, que aquece o planeta).
- **Rotas:** estradas, navios (veleiro, vapor, cargueiro) e aviões.

**Poderes de deus.** Terreno, água, floresta, chuva, calor, pressão, sol, seca, tempestade,
furacão (nasce no mar tropical, ganha nome e categoria), fogo, vulcão, meteoro, terremoto
(com réplicas; de 8,5 para cima racha a placa) e guerra nuclear. Sobre os povos: bênção,
inspiração, peste, profeta, discórdia e paz. Toda ferramenta funciona segurando e
arrastando. Três terremotos de 9 ou mais em seguida disparam um cataclismo: o planeta derrete,
os oceanos fervem, tudo esfria de novo com continentes novos e a vida recomeça.

**Para jogar.**

- **Início:** seis cenários (Clássico, Pangeia, Arquipélago, Era do gelo, Planeta quente,
  Terra jovem) e dez desafios com progresso e troféus.
- **Tempo:** desfazer, voltar no tempo de 10 em 10 anos, salvar e carregar mundos (arquivo
  `.json.gz`).
- **Leitura do mundo:** livro da história (a vida e as eras de cada povo e os grandes
  momentos), aba de dados (temperatura, CO₂, nível do mar, população) e notificações de
  tudo que acontece.
- **Visão:** Satélite (cores reais, cidades como luzes à noite, grade de latitude e longitude) ou
  Ilustrado (árvores, montanhas, casas).
- **Mapas:** biomas, temperatura, chuva, umidade, pressão, relevo, rios, mudança do terreno,
  placas, impacto humano, povos, eras, religião, idiomas, peste, fome e guerras, com paletas
  científicas (coolwarm, YlGnBu, viridis, PuOr) e unidades reais (°C, mm/ano, hPa, m, km).

### Controles do 2D

| Ação | Teclado / mouse |
| --- | --- |
| Mover o mapa | **W A S D** ou setas (Shift: mais rápido), arrastar com Olhar (**0**) |
| Zoom | roda do mouse |
| Ferramentas | **0–9**, **F** fogo, **V** vulcão, **M** meteoro, **B** pressão, **G** placas, **H** terremoto, **U** guerra nuclear, **Y** furacão |
| Poderes sobre os povos | **7** povo, **J** bênção, **K** inspiração, **L** peste, **N** profeta, **Q** discórdia, **E** paz |
| Adicionar / remover | **X** |
| Tamanho do pincel (ou magnitude do terremoto) | **[ ]** ou Shift + roda |
| Pausar · desfazer | **P** ou Espaço · **Ctrl + Z** |
| Trocar o mapa · Satélite/Ilustrado · setas de vento | **O** (Shift + O volta) · **I** · **T** |
| Enquadrar o mundo · atalhos | **R** · **?** |

### Escolhas e simplificações do 2D

O 2D é uma simulação de brinquedo com física de verdade por baixo. Onde o realismo atrapalha o
jogo, ele cede, e as concessões estão anotadas no código:

- **O clima tem seu próprio ritmo.** O ano dos povos dura 10 s em 1×, porque a história
  precisa de séculos. As estações dão uma volta a cada 60 s e o dia dura 20 s, para dar tempo
  de ver a sombra curvar. O calendário não é coerente (cada volta das estações equivale a
  6 anos de história), e foi de propósito.
- **Escala exagerada.** O mar sobe ~18 m por °C de aquecimento, perto do equilíbrio de longo
  prazo, para as costas alagarem de forma visível. Os degraus de falha dos terremotos chegam a
  ~120 m. As placas andam um tile a cada poucos segundos.
- **Conservação.** A crosta empurrada numa colisão vira volume de montanha, e a erosão devolve
  sedimento às planícies, para a terra não sumir com o tempo. Ainda assim, ciclos longos de
  deriva perdem alguma área.
- **Calibração por simulação.** Constantes como evaporação, transpiração das plantas,
  convergência do vento e limites dos furacões (25 °C) foram ajustadas rodando o mundo em Node
  e medindo floresta, terra nua, neve e temperatura por latitude. O planeta resultante tem
  ~14 °C de média e ~20–30% de terra nua.
- **O mapa é quadrado.** A projeção é achatada: cada tile cobre o dobro de graus na horizontal.
  O mundo não dá a volta nas bordas, então os continentes param antes delas.
- **O 3D é outra coisa.** Os povos são o mesmo código nas duas versões, mas o 2D tem física
  própria (CPU, tiles) e não tenta reproduzir o 3D.

## Craftscape 3D

### Controles

| Ação | Mouse / teclado | Toque |
| --- | --- | --- |
| Pintar | segurar **Espaço** com o cursor sobre o terreno, ou ativar "Pintar com clique" | botão **Pintar** + arrastar |
| Girar câmera | arrastar | 1 dedo |
| Mover câmera | botão direito ou Shift + arrastar, **W A S D** (Q/E sobe e desce) | 2 dedos |
| Zoom | roda do mouse | pinça |
| Tamanho do pincel | Shift + roda, **[** e **]** | slider |
| Ferramenta | **1** rocha, **2** solo, **3** areia, **4** água | painel |
| Desfazer | **Ctrl + Z** | botão Desfazer |
| Pausar · câmera órbita/voo | **P** · **C** | painel |

### O que mudou em relação ao original

- **WebGPU + compute shaders** no lugar de WebGL1 com render-to-texture. Tudo em `f32`: o
  original dependia de drivers que ignoravam `mediump`, e em drivers atuais (Mesa/AMD) a
  chuva e o pincel arredondavam para zero.
- **Passo de simulação fixo** (60 por segundo): a velocidade não depende mais do FPS do monitor.
- **Pincel no relevo**: um ray march acha o ponto exato sob o cursor (o original projetava no
  plano de altura zero).
- **Materiais novos**: areia (desliza além do ângulo de repouso e é carregada pela água),
  neve, gelo e vegetação que cresce em solo úmido, segura o solo contra a erosão e morre
  afogada.
- **Clima**: vento que carrega vapor e faz sombra de chuva atrás das montanhas, sistemas de
  alta e baixa pressão, dia e noite, nuvens em camadas, lava e vulcões, mapas de dados (biomas,
  temperatura, chuva, pressão e outros).
- **Mundo infinito**: a janela de simulação desliza pelo mundo, guardando as regiões já
  visitadas.
- **Povos e placas**: civilizações (`life.ts`) e placas tectônicas (`plates.ts`), desafios e
  cenários prontos.
- **Salvar/carregar** o terreno (`.craftscape`, gzip), **importar heightmap** (PNG/JPG) e
  **desfazer**.
- **Desempenho**: malha em chunks com LOD por distância, culling por frustum e costura entre
  níveis; sombras por ray march no heightfield e oclusão espalhadas ao longo de 4 quadros;
  resolução da simulação de 256² a 2048², com modo automático que reduz se ficar lento.
- Interface em React; sem jQuery nem scripts globais.

## Estrutura

```
src/main.tsx      entrada do 3D (redireciona ao 2D sem WebGPU)
src/engine/
  engine.ts       laço principal, passo fixo, pincel, undo, arquivos, resolução
  simulation.ts   buffers e passes de compute da simulação
  renderer.ts     terreno, água e céu; LOD por chunks
  life.ts         povos e civilizações (usado pelo 3D e pelo 2D)
  plates.ts       placas tectônicas do 3D
  camera.ts, input.ts, io.ts, settings.ts, ...
  shaders/sim.ts     WGSL da simulação (água, erosão, areia, vegetação, clima, sombras, picking)
  shaders/render.ts  WGSL de renderização
src/ui/           interface do 3D em React (fallback.ts: a ida para o 2D)
src/tiles/        Craftscape 2D
  world.ts        a simulação: clima, estações, pressão, água, rios, vegetação, desastres
  tectonics.ts    placas que andam, colisões, riftes, rachaduras
  game.ts         laço, entrada, poderes, desfazer/voltar no tempo, desafios
  render.ts       canvas 2D: visão satélite/ilustrada, mapas, sombra da Terra, efeitos
  goals.ts        cenários e desafios
  save.ts         mundos salvos (JSON gzip)
  sound.ts        sons gerados com Web Audio
  App.tsx, Extras.tsx, Charts.tsx   interface
```

No 3D, o estado da simulação são buffers `N×N` de `vec4f`:
`ground` = (altura total, rocha, solo, areia), `water` = (profundidade, fluxo x, fluxo y),
`extra` = (vegetação, umidade). O 2D usa o mesmo layout (um `Field` de 4 floats por tile),
por isso os povos rodam iguais nas duas versões.

## Licença

[GNU AGPL-3.0](LICENSE), como o original. Copyright © 2011 Florian Boesch pelo Craftscape
original; ruído simplex de Ashima Arts (MIT). Se você publicar uma versão modificada como
site, a AGPL exige disponibilizar o código-fonte para quem usa — um link para o repositório
basta.
