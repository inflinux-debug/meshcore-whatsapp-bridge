# MeshCore → WhatsApp Bridge

Ponte que **recebe mensagens do rádio MeshCore via Bluetooth (BLE)** e as
**encaminha automaticamente para um contato fixo no WhatsApp Web**.

```
[Rádio MeshCore] --BLE--> [Este app Node.js] --whatsapp-web.js--> [WhatsApp do contato]
```

## Como funciona

1. Conecta no firmware *companion* do MeshCore usando o Nordic UART Service (BLE).
2. Faz login (`CMD_APP_START`) e drena a fila de mensagens (`GET_MSG`).
3. Lê mensagens de duas formas: quando o rádio sinaliza `MSG_WAITING` **e** por
   um **poll periódico** (rede de segurança caso algum aviso se perca).
4. Reenvia o texto para o número configurado via WhatsApp Web.
5. Se o WhatsApp estiver fora do ar, as mensagens ficam numa **fila** (com
   limite) e são reenviadas quando ele voltar.

## Pré-requisitos

- **Node.js 18+** (testado no 24). Instalado em `C:\Program Files\nodejs`.
- Adaptador **Bluetooth Low Energy** ligado no PC (BLE via WinRT no Windows).
- **Chrome ou Edge** já instalado (o app reutiliza esse navegador — ver abaixo).
- Um **celular com WhatsApp** para escanear o QR na primeira execução.
- Rádio MeshCore com firmware **companion** (BLE), pareável.

> **BLE:** este projeto usa `@stoprocent/noble` (binários prebuilt). O
> `@abandonware/noble` **não** compila em Node 23+ sem o Visual Studio C++.

> **Navegador:** o download automático do Chromium do puppeteer costuma ser
> **bloqueado por antivírus** no Windows. Por isso o app usa o Chrome/Edge já
> instalado. Defina `CHROME_PATH` no `.env` ou deixe o app autodetectar.

## Instalação

```powershell
cd meshcore-whatsapp-bridge
npm install
Copy-Item .env.example .env
```

Edite o `.env`:

| Variável | Descrição |
|---|---|
| `WHATSAPP_TARGET` | Número destino, só dígitos, com DDI. Ex.: `5511999998888` |
| `MESSAGE_PREFIX` | Prefixo opcional em cada mensagem. Ex.: `[MeshCore]` |
| `CHROME_PATH` | (Opcional) caminho do Chrome/Edge. Vazio = autodetecta |
| `MESHCORE_DEVICE_NAME` | (Opcional) filtra o rádio pelo nome anunciado |
| `MESHCORE_DEVICE_ID` | (Opcional) conecta direto por MAC/ID do periférico BLE |
| `MESHCORE_POLL_MS` | (Opcional) intervalo do poll de mensagens (padrão 4000) |
| `APP_NAME` | Nome que a ponte anuncia ao rádio |

## Uso

```powershell
npm start
# ou: & "C:\Program Files\nodejs\node.exe" src\index.js
```

Na **primeira vez**:
1. Um QR Code aparece no terminal → abra o WhatsApp no celular →
   *Aparelhos conectados* → *Conectar aparelho* → escaneie.
2. A sessão fica salva em `.wwebjs_auth/` (não precisa repetir).
3. A ponte procura o rádio MeshCore por BLE e conecta sozinha.

A partir daí, toda mensagem recebida no MeshCore cai no seu WhatsApp.
Encerre com **`Ctrl+C`** (encerramento limpo, sem deixar o BLE preso).

## Solução de problemas

- **Rádio não é encontrado no BLE:** ele aceita **uma** conexão por vez. Feche o
  app MeshCore do celular / nRF Connect e, se preciso, **desligue e ligue** o
  rádio (uma conexão anterior mal encerrada o deixa sem anunciar).
- **WhatsApp trava em "autenticado":** perfil do Chrome travado. Apague o
  `SingletonLock` em `.wwebjs_auth/` (ou a pasta `.wwebjs_auth/` toda para
  reparear) e rode de novo.
- **Mensagem chega e "para":** já corrigido — leitura por poll + watchdog.

## Observações

- **whatsapp-web.js não é oficial** (automatiza o WhatsApp Web via navegador).
  Use com um número que possa correr esse risco de ToS.
- O parsing cobre `CONTACT_MSG_RECV` (0x07), a variante com SNR (0x10) e
  mensagens de canal (0x08). Pushes de rede (adverts etc., `0x80`–`0x8A`) são
  registrados como tráfego de fundo e ignorados. Conforme a versão do firmware,
  ajuste em [`src/meshcore.js`](src/meshcore.js) se algum campo divergir.

## Referências do protocolo

- Companion Protocol (oficial): https://docs.meshcore.io/companion_protocol/
- Wiki: https://github.com/meshcore-dev/MeshCore/wiki/Companion-Radio-Protocol
- Lib de referência (Python): https://github.com/meshcore-dev/meshcore_py
