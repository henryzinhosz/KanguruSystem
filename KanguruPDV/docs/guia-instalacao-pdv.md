# Guia de instalação do Kanguru PDV

Este guia é para quem vai colocar o Kanguru PDV para funcionar numa loja nova: o franqueado ou o técnico de confiança dele. Não precisa saber programar. Siga as etapas na ordem.

---

## 1. Antes de começar

**Peça ao suporte do Kanguru:**
- o acesso ao **ERP** (e-mail e senha da conta de administrador da sua empresa);
- um **código de ativação** para cada computador de caixa. O código vale por **24 horas** e só pode ser usado uma vez.

**Confira o computador do caixa:**
- Windows 10 ou 11 (64 bits);
- internet funcionando (o PDV também vende sem internet, mas a instalação e a ativação precisam dela);
- **impressora térmica de cupom** (80 mm) ligada, com o driver instalado e aparecendo em *Configurações do Windows › Impressoras*;
- leitor de código de barras USB (opcional): funciona como um teclado, não precisa de instalação.

---

## 2. Prepare a loja no ERP

Entre no ERP com a conta de administrador e faça, nesta ordem:

1. **Configurações › Lojas cadastradas:** clique no lápis da loja e confira os dados da loja (razão social, nome fantasia, CNPJ, inscrição estadual, endereço, telefone e Instagram). Eles saem no cupom.
2. **Configurações › Senha Gerente do PDV:** clique em **Definir senha** na loja. Escolha uma senha de pelo menos 6 caracteres e guarde-a: ela é pedida para desbloquear o PDV, fechar o caixa, fazer sangria e suprimento, abrir a gaveta, liberar desconto acima do limite, devoluções em dinheiro e nas Configurações do PDV.
3. **Configurações › Operadores do PDV:** cadastre cada vendedor com nome, loja e um **código de 2 dígitos** (01 a 99). O código é pedido em toda venda.
4. **Catálogo & Estoque:** cadastre os produtos. Para emitir NFC-e, cada produto precisa dos dados fiscais (NCM, origem, CSOSN ou CST, ICMS e total de tributos). Na dúvida, confirme com o seu contador.
5. **Serviços / OS › Cadastro de serviços:** cadastre os serviços (limpeza, troca de pasta térmica etc.). Eles aparecem na venda e na Ordem de Serviço.
6. **Catálogo & Estoque › Entrada de Estoque:** lance o estoque inicial com o custo de cada produto.

> **NFC-e:** a chave da Focus NFe da loja é configurada pelo suporte do Kanguru. Em *Configurações*, a loja mostra se a NFC-e está "configurada" ou não. Enquanto não estiver, o PDV vende só com cupom Não Fiscal.

---

## 3. Instale o PDV no computador do caixa

1. No computador do caixa, baixe o instalador por este link (sempre traz a versão mais recente):
   **https://qnxmboxwluuyjvgiqlbm.supabase.co/storage/v1/object/public/pdv-updates/Kanguru-PDV-setup.exe**
2. Abra o arquivo baixado.
   - Se aparecer a tela azul **"O Windows protegeu o computador"**, clique em **Mais informações › Executar assim mesmo**. Isso acontece porque o instalador ainda não tem assinatura digital; é seguro.
   - Se aparecer **"O controle inteligente de aplicativos bloqueou um aplicativo"**, esse computador não consegue instalar o PDV por enquanto. Use outro computador ou fale com o suporte.
3. Siga o instalador até o fim. O atalho **Kanguru PDV** fica no menu Iniciar e na área de trabalho.

---

## 4. Ative o terminal (só na primeira vez)

1. Abra o **Kanguru PDV**.
2. Na tela **Ativar terminal**, preencha:
   - **Nome do terminal:** ex. "Caixa 01";
   - **Código de ativação:** o código que o suporte enviou.
3. Clique em **Ativar terminal**. O PDV mostra os dados da loja.
4. Se aparecer **"Cadastre a senha Gerente"**, a etapa 2.2 ainda não foi feita: cadastre a senha no ERP e clique em **Já cadastrei, continuar**.
5. Na tela **Desbloquear terminal**, digite a **senha Gerente**.

Depois disso o computador fica ligado à loja. Nas próximas vezes o PDV abre direto em *Desbloquear terminal*.

---

## 5. Configure a impressora

1. No menu inicial do PDV, clique em **Configurações** (botão roxo) e digite a senha Gerente.
2. Escolha **Impressora**, selecione a impressora térmica da lista e clique em **Imprimir teste**.
3. Saiu o teste? Salve. Com a impressora configurada, o cupom sai direto e a gaveta abre sozinha nas vendas em dinheiro.

---

## 6. Primeiro dia de uso

1. **Abrir caixa:** informe o responsável e o fundo de troco. Sai o relatório de abertura.
2. **Nova venda (F1):** bipe ou busque os produtos, informe o código do vendedor e finalize em **NFC-e** ou **Não Fiscal**.
3. **Fechar caixa (Menu › Operacional):** conte o dinheiro e as demais formas de pagamento, digite a senha Gerente e confirme. Sai o relatório de fechamento.

---

## 7. Atualizações

O PDV procura versão nova sozinho ao abrir e a cada 4 horas. Quando aparecer o aviso, clique em **Atualizar agora** fora do horário de movimento: o PDV fecha, instala e abre de novo. O aviso nunca aparece no meio de uma venda.

---

## 8. Problemas comuns

| O que acontece | O que fazer |
|---|---|
| "Código de ativação inválido" | O código expira em 24 horas e só vale uma vez. Peça um novo ao suporte. |
| "Senha Gerente incorreta" e depois bloqueio | Depois de 5 erros a senha fica bloqueada por 15 minutos. Espere e tente de novo. Se esqueceu a senha, o administrador troca no ERP. |
| Cupom não imprime | Confira se a impressora está ligada e com papel, e refaça o teste em *Configurações › Impressora*. |
| Faixa "MODO OFFLINE" | A internet caiu. Pode continuar vendendo; as vendas sobem sozinhas quando a internet voltar. O fechamento do caixa só é liberado depois que tudo for enviado. |
| Atualização fecha o PDV e ele não volta | O Windows bloqueou o instalador. Abra o PDV pelo atalho (ele continua na versão anterior) e instale pelo link da etapa 3. |

**Suporte Kanguru:** _(preencher com telefone/WhatsApp e e-mail do suporte)_
