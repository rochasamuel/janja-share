# Enviando o app para um amigo

Três coisas precisam ser verdade antes de um amigo em outra casa conseguir
entrar no seu canal. O instalador é a parte fácil.

1. Um servidor de sinalização que os dois alcancem pela internet
2. O app compilado com o endereço desse servidor gravado dentro
3. TURN, para os amigos cuja rede não permite conexão direta

Existem dois caminhos para o item 1. Comece pelo túnel: dá para testar com um
amigo de verdade hoje à noite, sem alugar nada.

---

## Caminho A — túnel temporário da Cloudflare

Sem conta, sem domínio, sem cartão. O `cloudflared` abre um endereço público
que aponta para o servidor rodando na sua máquina.

### Instalar o cloudflared (uma vez só)

```bash
curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  -o ~/.local/bin/cloudflared
chmod +x ~/.local/bin/cloudflared
```

### Abrir o túnel

Dois terminais. No primeiro, o servidor:

```bash
pnpm dev:signal
```

No segundo, o túnel:

```bash
pnpm dev:tunnel
```

Ele confere que o servidor local responde, abre o túnel, espera o endereço
propagar na borda da Cloudflare, confirma que responde de fora e imprime o
comando de build já pronto:

```
  endereço temporário: https://algo-aleatorio.trycloudflare.com
  para o app:          wss://algo-aleatorio.trycloudflare.com
```

**Deixe os dois terminais abertos.** Se fecharem, o endereço morre e todo
instalador gerado com ele para de funcionar — inclusive os que já estão na
máquina dos seus amigos.

### Os três limites honestos deste caminho

| Limite | O que significa na prática |
|---|---|
| O endereço muda a cada execução | O endereço fica gravado no `.exe` no momento do build. Reiniciou o túnel? Tem que buildar de novo e reenviar o instalador para todo mundo. |
| Não passa TURN | Um túnel HTTP não carrega o UDP do relay. Amigos atrás de NAT restrito ou CGNAT (comum em internet via rádio e em alguns planos de fibra no Brasil) simplesmente não conectam. Uns 8 em cada 10 funcionam. |
| Sua máquina é o servidor | Enquanto você não estiver com os dois terminais rodando, ninguém entra em canal nenhum. |

Se os três incomodarem, é hora do caminho B.

---

## Caminho B — um VPS com domínio próprio

Endereço fixo, TURN de verdade, funciona sem a sua máquina ligada.

### O que alugar

Qualquer caixa de 1 GB. O processo de sinalização é minúsculo — troca alguns
kilobytes por conexão. O que custa dinheiro é a banda do TURN, e só nas
conexões que precisam de relay.

| Provedor | Custo aproximado | Nota |
|---|---|---|
| Hetzner CX22 | ~€4/mês | 20 TB de tráfego incluídos; a melhor relação |
| Contabo VPS S | ~€5/mês | Tráfego generoso |
| DigitalOcean | ~US$6/mês | 1 TB, depois cobra por GB |

Olhe a **franquia de tráfego**, não a CPU. Uma sessão de 6 espectadores com
relay move uns 36 Mbps para cada lado; uma noite disso são dezenas de gigabytes.

### DNS primeiro

Aponte um registro A para o VPS antes de fazer o deploy. O Caddy não consegue
emitir certificado enquanto o nome não resolver para a máquina, e todo o resto
depende desse certificado.

```
janja.exemplo.com.   A   <ip do vps>
```

### Deploy

Numa máquina Ubuntu nova:

```bash
curl -fsSL https://get.docker.com | sh
git clone <seu repositório> janja-share
cd janja-share/infra
./deploy.sh janja.exemplo.com
```

O script faz tudo: detecta o IP público, avisa se o DNS ainda não aponta para
ele, gera o segredo do TURN, escreve o `.env`, abre o firewall incluindo a
faixa de portas do relay, sobe Caddy, sinalização e coturn, espera o
certificado e imprime o comando de build exato.

É seguro rodar de novo. Ele preserva o `TURN_SECRET` existente em vez de gerar
outro, porque rotacionar esse segredo invalida toda credencial já distribuída.

---

## 2. Gerando o instalador

Antes de qualquer build que vá para a mão de alguém, **suba o número da
versão**. Ele vai no nome do instalador, e é a única forma de saber qual build
seu amigo está rodando quando algo der errado:

```bash
pnpm version:bump 0.2.1
```

Isso troca o número nos quatro arquivos que o guardam (`tauri.conf.json`,
`Cargo.toml`, `Cargo.lock` e o `package.json` do desktop). Um build sem subir a
versão sai com o nome do anterior, e dois instaladores diferentes com o mesmo
nome é uma confusão garantida.

O endereço da sinalização é compilado junto, então **só builde depois** de
saber o endereço.

O código vive no WSL, mas o Tauri compila nativo no Windows. Primeiro, espelhe
o projeto para o lado Windows:

```bash
pnpm sync:win
```

Depois, no PowerShell **do Windows**:

```powershell
cd C:\Users\sams\source\janja-share
pnpm install
cd apps\desktop
$env:VITE_SIGNALING_URL = "wss://algo-aleatorio.trycloudflare.com"
pnpm tauri build
```

O `$env:` vale só para aquela janela do PowerShell. Abriu outra, tem que
definir de novo — e se esquecer, o app sai apontando para `localhost` e nenhum
amigo conecta.

Na primeira vez isso demora bastante: o Rust compila umas 500 dependências.
Nas seguintes é rápido, porque o cache fica em `src-tauri\target`.

A saída vai para `apps\desktop\src-tauri\target\release\bundle\`:

| Arquivo | Para quê |
|---|---|
| `nsis\Janja Share_0.2.0_x64-setup.exe` | **Mande este.** Instalador comum do Windows. |
| `msi\Janja Share_0.2.0_x64_en-US.msi` | Para máquinas gerenciadas e política de grupo |

Seu amigo não precisa instalar mais nada. Sem Node, sem Rust, sem terminal. O
WebView2 já vem em todo Windows 11 e no Windows 10 atualizado; o instalador
baixa se por acaso faltar.

### O aviso de executável não assinado

O instalador não é assinado digitalmente, então o SmartScreen do Windows vai
mostrar a caixa azul "O Windows protegeu o seu computador". Seu amigo precisa
clicar em **Mais informações** e depois **Executar assim mesmo**. Avise antes,
senão ele vai achar que é vírus — e vai estar certo em achar.

Certificado de assinatura custa algumas centenas de dólares por ano. Só vale a
pena se isto passar do círculo de amigos.

---

## 3. Conferindo que funciona mesmo

Teste nesta ordem. Cada passo elimina uma falha diferente.

**O servidor está acessível?**

```bash
curl https://algo-aleatorio.trycloudflare.com/healthz
```

Espere `{"ok":true,"channels":0}`. Se isto falhar, nada mais pode funcionar.

**O app chega nele?** Abra o app. O cabeçalho diz `conectado`. Se disser
`sem conexão`, o endereço estava errado na hora do build, e nenhuma tentativa
do lado do seu amigo vai resolver.

**A conexão direta funciona?** Siga o passo a passo do canal abaixo. Se a
imagem chegar, você nunca precisou de TURN.

**O relay funciona?** (só faz sentido no caminho B) Isto tem que ser forçado,
porque uma conexão que silenciosamente funcionou peer-to-peer é idêntica a um
relay funcionando:

```powershell
$env:VITE_FORCE_RELAY = "1"
pnpm tauri build
```

Esse build descarta os candidatos diretos por completo. Se a imagem ainda
chegar, o TURN funciona de verdade e os amigos atrás de NAT restrito vão ficar
bem. Jogue esse build fora depois — ele força toda conexão pela banda do seu
servidor.

---

## Usando o canal

O canal é o encontro; a transmissão é opcional dentro dele.

1. **Você:** abra o app e clique em **Criar um canal** (`Ctrl N`). Aparecem
   seis caracteres.
2. **Você:** leia os seis caracteres em voz alta, ou clique em **Copiar
   código** e mande pelo chat.
3. **Seu amigo:** **Entrar em um canal** (`Ctrl J`), digita o código, Enter.
4. Os dois aparecem na lista, cada um com o nome do próprio PC. Ninguém está
   transmitindo ainda, e nenhuma conexão foi construída — entrar no canal não
   custa nada.
5. **Quem quiser mostrar a tela:** **Compartilhar minha tela** (`Ctrl S`).
   Um selo **ao vivo** aparece ao lado do nome dessa pessoa para todo mundo.
6. **Quem quiser assistir:** clique no nome de quem está ao vivo. *Só agora* a
   conexão é construída.

Qualquer um pode fazer os dois ao mesmo tempo: transmitir a própria tela e
assistir à de outra pessoa. O que não dá é assistir a duas ao mesmo tempo —
pare uma antes de abrir a outra.

Sair da transmissão (`Esc`) mantém você no canal. Para sair de vez, use **Sair
do canal**.

---

## O que seu amigo deve esperar

Seis espectadores é o teto **por pessoa que transmite**, e quem define isso é o
**upload de quem transmite**, não a conexão de quem assiste. Cada espectador recebe uma cópia separada da transmissão saindo
da sua máquina: seis deles a 6 Mbps dão uns 36 Mbps de upload. Num plano
assimétrico típico (digamos 300 de download e 30 de upload), três ou quatro
espectadores vão ser o limite real, e o app baixa a qualidade em vez de
derrubar alguém.

Se para você está tudo liso e seus amigos veem apresentação de slides, o
motivo é quase sempre o seu upload, não o download deles.

Um canal com oito pessoas não custa oito vezes mais: a conta só existe para
quem está transmitindo, e só conta quem clicou para assistir.

Vale ajustar o preset em **Qualidade** (`Ctrl ,`): "Economia de banda" a 2,5
Mbps por espectador cabe em bem mais lugares que o "Automático" a 8.

---

## Se o app estiver comendo CPU

A tela de compartilhamento tem uma linha **Encoder**. Ela é o diagnóstico:

| O que aparece | O que significa |
|---|---|
| `H264 · GPU` | Certo. A placa de vídeo está fazendo o trabalho. |
| `VP8 · CPU` ou qualquer coisa `· CPU` (em vermelho) | O encoding caiu para software. Com 6 espectadores são 6 encoders no processador — é isto que derruba o FPS do jogo. |

Compartilhar cria **um encoder por espectador**: a malha P2P não tem como
reaproveitar. Por isso o preset importa tanto. Para jogar, use **Jogo**
(`Ctrl ,`): metade dos quadros é metade do trabalho de encoding, e o
`contentHint` de movimento impede o encoder de gastar orçamento preservando
bordas de uma cena que muda inteira a cada quadro.

### Se o jogo engasga enquanto compartilha

Nesta ordem, porque cada passo é maior que o seguinte:

1. **Preset Jogo** (`Ctrl ,`). O padrão "Automático" captura a 60 fps e pede
   ao encoder para proteger nitidez — a combinação mais cara que existe para
   um jogo. O preset vale na hora, sem parar a transmissão.
2. **Encoder dizendo `· GPU`**. Se estiver `· CPU`, veja a seção abaixo; com
   três espectadores em software nenhum preset salva.
3. **Quem não precisa de tela cheia, que fique no painel.** Quem assiste no
   painel recebe uma imagem a um terço da largura e no máximo 30 fps; quem
   está em tela cheia recebe tudo. Seis espectadores em tela cheia é o pior
   caso; seis no painel custa uma fração disso.
4. **Feche o painel enquanto joga** (`Esc` até a tela inicial, e `Esc` de
   novo; ou clique no ícone da bandeja). A transmissão continua; o que para
   é o desenho de uma janela que ninguém está vendo.

O que o app não consegue mudar: a captura de tela do Chromium copia cada
quadro da GPU para a memória antes de encodar. Num monitor 4K a 60 fps isso
são dois gigabytes por segundo só de cópia, e a única defesa é capturar menos
quadros — o que o preset Jogo faz.

### Se continuar dizendo `· CPU`

Aí o hardware de encode está sendo recusado pelo Chromium — normalmente porque
o driver da sua GPU está na lista de bloqueio dele. Dá para ignorar essa lista
em `apps/desktop/src-tauri/tauri.conf.json`, na janela `main`:

```json
"additionalBrowserArgs": "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --ignore-gpu-blocklist"
```

Os três `--disable-features` **precisam** estar aí: o wry passa exatamente
esses por padrão, e definir `additionalBrowserArgs` substitui o valor inteiro.

Isto é a última carta, não a primeira: a lista de bloqueio existe porque
alguns drivers travam ou produzem artefatos ao encodar. Aplique só depois que
a linha Encoder tiver dito `· CPU`, e confira se ela virou `· GPU` depois.
