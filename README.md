# Craftscape

Simulação de terreno em tempo real no navegador: esculpa rocha, solo e areia, jogue água e
veja chuva, rios, erosão e vegetação mudarem a paisagem. Tudo roda na GPU via **WebGPU**.

É uma reescrita do [Craftscape original](https://github.com/pyalot/craftscape) de
Florian Boesch (2011, WebGL1 + jQuery). A física da água, da erosão e o visual são ports dos
shaders originais para WGSL; o resto (engine, câmera, interface) foi reescrito.

## Rodando

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # gera dist/ (site estático)
```

Precisa de um navegador com WebGPU. No **Chrome para Linux** ele vem desligado: ative
`chrome://flags/#enable-unsafe-webgpu` e `chrome://flags/#enable-vulkan` e reinicie o navegador.

### Craftscape 2D (sem GPU)

Em `/2d.html` há uma segunda versão do jogo: um mundo de tiles visto de cima, simulado na CPU
com regras simples (vento, chuva, rios por acúmulo de fluxo, vegetação, neve, lava, fogo) e os
mesmos povos da versão 3D (`src/engine/life.ts`) vivendo em cima. Roda em qualquer navegador,
sem WebGPU. O código fica em `src/tiles/`: `world.ts` (simulação), `render.ts` (canvas 2D e
sprites procedurais), `game.ts` (laço, entrada, poderes) e `App.tsx` (interface).

A aba **Mapa** traz os mesmos modos de mapa do 3D: biomas, temperatura, chuva, ar (umidade),
pressão (as secas decretadas em laranja, as tempestades em roxo), relevo com curvas de nível,
rios pela vazão, mudança do terreno desde a referência e o atlas dos povos (terra cor de papel,
fronteiras e frentes de guerra), com legenda para cada um, além das setas de vento que giram em
volta das tempestades e das altas. Teclas: **O** troca o mapa (Shift+O volta), **W** liga as
setas de vento, setas do teclado movem o mapa, **R** enquadra o mundo.

## Controles

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

## O que mudou em relação ao original

- **WebGPU + compute shaders** no lugar de WebGL1 com render-to-texture. Tudo em `f32`: o
  original dependia de drivers que ignoravam `mediump`, e em drivers atuais (Mesa/AMD) a
  chuva e o pincel arredondavam para zero.
- **Passo de simulação fixo** (60 por segundo): a velocidade não depende mais do FPS do monitor.
- **Pincel no relevo**: um ray march acha o ponto exato sob o cursor (o original projetava no
  plano de altura zero).
- **Materiais novos**: areia (desliza além do ângulo de repouso e é carregada pela água),
  neve acima de uma altitude configurável e vegetação que cresce em solo úmido, segura o solo
  contra a erosão e morre afogada.
- **Salvar/carregar** o terreno (`.craftscape`, gzip), **importar heightmap** (PNG/JPG) e
  **desfazer**.
- **Desempenho**: malha em chunks com LOD por distância, culling por frustum e costura entre
  níveis; sombras por ray march no heightfield e oclusão espalhadas ao longo de 4 quadros;
  resolução da simulação 256²/512²/1024², com modo automático que reduz se ficar lento.
- Interface em React; sem jQuery nem scripts globais.

## Estrutura

```
src/engine/
  engine.ts       laço principal, passo fixo, pincel, undo, arquivos, resolução
  simulation.ts   buffers e passes de compute da simulação
  renderer.ts     terreno, água e céu; LOD por chunks
  camera.ts       câmera órbita e voo livre
  input.ts        mouse, toque e teclado
  io.ts           formato .craftscape, heightmap, reamostragem
  shaders/sim.ts     WGSL da simulação (água, erosão, areia, vegetação, sombras, picking)
  shaders/render.ts  WGSL de renderização
src/ui/           painel de controle em React
```

O estado da simulação são buffers `N×N` de `vec4f`:
`ground` = (altura total, rocha, solo, areia), `water` = (profundidade, fluxo x, fluxo y),
`extra` = (vegetação, umidade).

## Licença

[GNU AGPL-3.0](LICENSE), como o original. Copyright © 2011 Florian Boesch pelo Craftscape
original; ruído simplex de Ashima Arts (MIT). Se você publicar uma versão modificada como
site, a AGPL exige disponibilizar o código-fonte para quem usa — um link para o repositório
basta.
