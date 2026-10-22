# Roadmap: Craftscape Moderno (WebGPU/WebGL + WASM + React)

## 📝 TODO List Detalhado

### 🟦 Fase 1: Infraestrutura (Vite, React & Emscripten)
- [x] Criar pasta `legacy/` e mover arquivos antigos (preservar histórico).
- [x] Inicializar projeto Vite com template `react-ts`.
- [x] Configurar `.gitignore` (incluindo artefatos de build do Emscripten `.wasm`, `.js`).
- [x] Criar estrutura de pastas:
    - `src/core/` (C++ Simulation)
    - `src/ui/` (React Components)
    - `src/render/` (WebGPU/WebGL logic)
    - `src/workers/` (Web Worker logic)
- [x] Criar um "Hello World" em C++ e configurar o `CMakeLists.txt` para Emscripten.
- [x] Script de build: Criar um comando `npm run build:wasm` que compila o C++ para a pasta `public/`.
- [x] Testar carregamento básico do módulo WASM no React (Main Thread).

### 🟨 Fase 2: A Ponte de Comunicação (Worker + Shared Memory)
- [x] Criar o Web Worker base em `src/workers/engine.worker.ts`.
- [x] Configurar o carregamento do WASM *dentro* do Worker.
- [x] Implementar detecção de suporte a `SharedArrayBuffer` (Cross-Origin isolation headers).
- [x] Implementar o primeiro `postMessage` entre UI e Worker via Comlink.
- [x] Criar a classe `TerrainBuffer` em C++ para gerenciar a memória do mapa.
- [x] Expor o ponteiro da memória via `embind` e lê-lo no JS como um `Float32Array`.

### 🟩 Fase 3: O Coração da Simulação (C++)
- [x] Transcrever a estrutura de dados básica do terreno (Heightmap/Voxels) para C++.
- [x] Migrar lógica de `copy.shader` (transmissão de massa) para funções C++.
- [x] Migrar lógica de `flows.shader` (cálculo de vetores de fluxo) para funções C++.
- [x] Implementar o loop de "Tick" (update) em C++ (60Hz fixo).
- [x] Adicionar controle de pausa/velocidade da simulação vindo da UI.

### 🟪 Fase 4: Renderização Híbrida (Graphics Pipeline)
- [ ] Criar detector de `navigator.gpu`.
- [ ] Implementar Contexto WebGL Fallback (usando o que já existe no `webgl/` como base).
- [ ] Criar o Vertex Buffer que lê diretamente do `SharedArrayBuffer` da simulação.
- [ ] Escrever Shaders básicos de visualização (Lambertian/Diffuse).
- [ ] Integrar o loop de renderização (rAF) com os dados atualizados pelo Worker.

### 🟥 Fase 5: Interface e Interação (User Experience)
- [ ] Criar painel de ferramentas (Brush Size, Material Type).
- [ ] Implementar sistema de Raycasting para detectar onde o mouse clica no terreno 3D.
- [ ] Enviar comando de "Pintar" (Adicionar Terra/Água) da UI para o Worker.
- [ ] Adicionar monitor de performance (FPS e Simulação ms).

---

## Detalhamento das Fases

### Fase 1: Fundação e Setup do Ecossistema
Inicializar o projeto frontend utilizando Vite com o template React + TypeScript.
Configurar o ambiente de compilação C++ (CMake + Emscripten) para gerar os binários .wasm e os bindings em JavaScript.
Estabelecer a ponte de comunicação inicial: fazer o React instanciar um Web Worker que, por sua vez, carrega e executa o módulo WASM.

### Fase 2: Estrutura de Comunicação (Worker <-> WASM <-> UI)
Implementar a passagem de mensagens. Para simulações pesadas como essa, o ideal é configurar as headers HTTP de isolamento (Cross-Origin-Opener-Policy e Cross-Origin-Embedder-Policy) para habilitar o uso de SharedArrayBuffer.
Mapear a memória da grade de voxels/terreno diretamente no C++ e compartilhar o ponteiro de memória com o JavaScript, evitando cópias custosas de dados a cada frame.

### Fase 3: O Motor de Simulação (C++)
Analisar os shaders originais do Craftscape (copy.shader, display.shader) e reescrever a lógica de erosão hídrica, evaporação e deslocamento de massa para C++ puro.
Criar uma classe controladora em C++ que gerencia os "ticks" da simulação (update de física) de forma independente do renderizador.

### Fase 4: Pipeline de Renderização Híbrida (WebGPU / WebGL)
Criar uma camada de abstração gráfica no C++. O Emscripten fornece suporte nativo tanto para WebGPU (<webgpu/webgpu.h>) quanto para WebGL (via tradução de chamadas OpenGL ES 2.0/3.0).
Implementar a detecção de hardware: ao inicializar, o código tenta criar o device WebGPU. Se falhar, inicializa o contexto WebGL clássico.
Mapear os dados processados na Fase 3 para os Buffers da GPU correspondentes. No WebGPU, usar Compute Shaders (WGSL) se possível; no WebGL, usar a abordagem antiga de renderizar para texturas (FBOs).

### Fase 5: Interface e Ferramentas (React)
Desenvolver a UI de controles flutuantes no React (seleção de materiais: água, terra, rocha; intensidade do pincel).
Capturar os eventos de clique/drag do mouse no canvas, converter as coordenadas da tela para o espaço 3D do mundo e enviar esses comandos via Worker para o motor em C++ modificar o terreno.

## Exemplo de Arquitetura: Exportando C++ para o Worker
Para a Fase 2 e 3, você usará o Emscripten WebIDL ou o embind para expor suas classes C++ para o JavaScript no Web Worker. Aqui está um exemplo básico de como essa ponte começa a tomar forma:

```cpp
#include <emscripten/bind.h>
#include <vector>

class TerrainSimulator {
private:
    int width, height;
    std::vector<float> heightMap;

public:
    TerrainSimulator(int w, int h) : width(w), height(h) {
        heightMap.resize(width * height, 0.0f);
    }

    // Função chamada a cada frame pelo Worker
    void stepSimulation(float deltaTime) {
        // Lógica de erosão e física aqui
    }

    // Retorna o ponteiro da memória para o JS ler diretamente (Zero-copy)
    intptr_t getHeightMapPointer() {
        return reinterpret_cast<intptr_t>(heightMap.data());
    }
};

// Binding para o Emscripten
EMSCRIPTEN_BINDINGS(craftscape_module) {
    emscripten::class_<TerrainSimulator>("TerrainSimulator")
        .constructor<int, int>()
        .function("stepSimulation", &TerrainSimulator::stepSimulation)
        .function("getHeightMapPointer", &TerrainSimulator::getHeightMapPointer);
}
```

📚 Bibliografia e Referências Técnicas
- Emscripten API Reference: A documentação oficial para interagir com o Web Worker e gerenciar a memória (SharedArrayBuffer).
- WebGPU C++ Headers (Dawn / Emscripten): O Emscripten usa os headers baseados na implementação Dawn do Google.
- Comlink (Google Chrome Labs): Uma biblioteca excelente para simplificar absurdamente a comunicação via postMessage com o Web Worker.
- Artigo de Pesquisa: "Interactive Terrain Modeling using Hydraulic Erosion" (Stava et al.).
