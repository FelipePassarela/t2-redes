# Mini DASH Player

Este projeto implementa um sistema completo de streaming multimídia utilizando o padrão **DASH (Dynamic Adaptive Streaming over HTTP)**. O sistema é composto por um servidor HTTP em Java e um player no cliente (Frontend) utilizando JavaScript puro e a **Media Source Extensions (MSE) API**.

A versão atual suporta **reprodução simultânea de áudio e vídeo**, com gerenciamento independente de buffers, **seeking sincronizado** entre áudio e vídeo e **ABR (Adaptive Bitrate)** para ajuste automático de qualidade de vídeo.

## 🚀 Funcionalidades

* **Servidor HTTP Customizado (Java):** Implementação de baixo nível usando `ServerSocket` e `ThreadPool` para servir fragmentos de mídia.
* **Player DASH com Áudio e Vídeo:**
  * Consumo de manifesto `.mpd`.
  * **Suporte Dual-Buffer:** Gerenciamento de `SourceBuffer` para vídeo e áudio.
  * **Sincronização do Seek:** Lógica de *seek* e *end-of-stream* unificada para garantir que som e imagem andem juntos.
* **Adaptive Bitrate (ABR):** Algoritmo que calcula a vazão média da rede e troca a qualidade do vídeo dinamicamente.

## 🛠️ Pré-requisitos

1. **Java JDK 21+**: Necessário devido à configuração do maven.compiler.source no pom.xml.

1. **Apache Maven**: Para compilar o projeto.

1. **Navegador Moderno**: Chrome, Firefox ou Edge (com suporte a MSE e codecs H.264/AAC).

1. **FFmpeg**: Para gerar o conteúdo DASH segmentado.

## ⚙️ Configuração e Execução

### 1\. Preparação da Mídia (Áudio + Vídeo)

O projeto já inclui um video padrão, portanto, essa etapa não é necessária.

Para converter seu próprio vídeo, coloque-o na pasta  `server\src\main\resources` e o nomeie como `video.mp4`. Em seguida, execute o script de segmentação:

```bash
./server/segment_video.bat
```

### 2\. Executando o Servidor (Backend)

```bash
cd server
mvn clean install
java -cp .\target\video-streaming-1.0-SNAPSHOT.jar .\src\main\java\org\example\Main.java
java -jar .\target\video-streaming-1.0-SNAPSHOT.jar
```

### 3\. Executando o Cliente (Frontend)

Execute um servidor HTTP simples na pasta `client`. Você pode usar o Python para isso:

```bash
cd client
python -m http.server 8000
```

Após isso, abra o navegador e acesse `http://localhost:8000`.
