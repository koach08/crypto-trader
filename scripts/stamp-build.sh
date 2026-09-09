#!/usr/bin/env bash
# 本番に何が乗っているかを断定できるようにする目印を焼き込む。
#
# 「push したから動いている」は仮定でしかない。実際 railway up が2回続けて
# 同じイメージ digest を出し、手元の変更が本番に届いていないことがあった。
# デプロイ前にこれを実行して commit すると /api/health で確認できる。
#
#   zsh scripts/stamp-build.sh && git add -A && git commit && railway up --detach
set -euo pipefail
cd "$(dirname "$0")/.."
SHA=$(git rev-parse --short HEAD)
AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat > src/lib/build-info.ts <<TS
/** 自動生成 (scripts/stamp-build.sh)。手で編集しない。 */
export const BUILD_INFO = { commit: "${SHA}", stampedAt: "${AT}" } as const;
TS
echo "stamped ${SHA} @ ${AT}"
