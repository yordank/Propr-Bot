# Propr Copy Bot

Копира позициите на Hyperliquid адрес в Propr акаунт (app.propr.xyz).

## Как работи
На всеки 3 сек. чете позициите на таргета в Hyperliquid, умножава ги по `RATIO`
и изравнява позициите в Propr с market ордери. Хваща отваряне, добавяне,
намаляне, затваряне и обръщане (long ↔ short). Ако нещо се размине, следващият
цикъл само го оправя.

`RATIO = MY_CAPITAL / TARGET_CAPITAL`

| Мой капитал | Таргет | RATIO |
|---|---|---|
| 5 000 | 200 000 | 0.025 |
| 100 000 | 200 000 | 0.5 (1:2) |
| 200 000 | 200 000 | 1 (1:1) |

С `MY_CAPITAL=auto` ботът взима размера на challenge-а сам.

## Старт
1. app.propr.xyz → Settings → генерирай API ключ (`pk_live_...`)
2. `cp .env.example .env` и сложи ключа
3. `node propr-copy.js` (Node 18+, без пакети)
4. Гледай лога в `DRY_RUN=true`. Когато е ОК → `DRY_RUN=false`

С pm2: `pm2 start propr-copy.js --name propr-copy`

## Важно за Propr
- **Лостът е ограничен:** BTC/ETH max 5x, всичко друго 2x. Ако таргетът е с
  по-голям лост, ботът намалява всички позиции пропорционално, за да се
  поберат (`MARGIN_SAFETY`).
- Поддържат се само основни perps и `xyz:` (акции/стоки). Други HIP-3 dex-ове се пропускат.
- Такса 0.075% на страна.
- Challenge-ът пада при max drawdown / daily loss — ботът не следи това.
