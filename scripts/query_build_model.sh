#!/bin/bash
#
# Build.MODEL 属性全面诊断与备份脚本
# 适用于华为/鸿蒙 AAOS 车机（享界S9 等）
# 用法: bash query_build_model.sh [设备序列号]
#

set -uo pipefail

# ========== 配置 ==========
SERIAL="${1:-}"
ADB="adb"
[ -n "$SERIAL" ] && ADB="adb -s $SERIAL"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="./build_model_backup_${TIMESTAMP}"

# ========== 颜色输出 ==========
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; }
title() { echo -e "\n${CYAN}====== $* ======${NC}"; }

# ========== 1. 设备连接检查 ==========
title "1. 设备连接检查"

if ! $ADB devices 2>/dev/null | grep -q "device$"; then
    error "未检测到设备连接，请检查："
    echo "  - USB 线是否连接"
    echo "  - USB 调试是否开启"
    echo "  - 驱动是否安装"
    $ADB devices -l
    exit 1
fi

DEVICE_INFO=$($ADB devices -l | grep "device " | head -1)
info "设备已连接: $DEVICE_INFO"

# ========== 2. 设备基本信息 ==========
title "2. 设备基本信息"

MODEL=$($ADB shell getprop ro.product.model 2>/dev/null | tr -d '\r')
BRAND=$($ADB shell getprop ro.product.brand 2>/dev/null | tr -d '\r')
DEVICE=$($ADB shell getprop ro.product.device 2>/dev/null | tr -d '\r')
ANDROID_VER=$($ADB shell getprop ro.build.version.release 2>/dev/null | tr -d '\r')
BUILD_ID=$($ADB shell getprop ro.build.display.id 2>/dev/null | tr -d '\r')

echo "  Brand:       $BRAND"
echo "  Model:       $MODEL"
echo "  Device:      $DEVICE"
echo "  Android:     $ANDROID_VER"
echo "  Build ID:    $BUILD_ID"

# 检测是否包含非 ASCII 字符
if echo "$MODEL" | grep -P '[^\x00-\x7F]' >/dev/null 2>&1; then
    warn "Build.MODEL 包含非 ASCII 字符: \"$MODEL\""
    warn "这会导致 Amazon Music 等应用的 HTTP Header 异常！"
else
    info "Build.MODEL 为纯 ASCII: \"$MODEL\""
fi

# ========== 3. 所有 model 相关属性 ==========
title "3. 所有 model 相关属性"

$ADB shell getprop | grep -i "model" | while IFS= read -r line; do
    if echo "$line" | grep -P '[^\x00-\x7F]' >/dev/null 2>&1; then
        echo -e "  ${RED}$line${NC}  ← 含非ASCII"
    else
        echo "  $line"
    fi
done

# ========== 4. 各分区 build.prop 中的 model 定义 ==========
title "4. 各分区 build.prop 中的 model 定义"

PROP_FILES=(
    "/system/build.prop"
    "/vendor/build.prop"
    "/vendor/odm/etc/build.prop"
    "/odm/etc/build.prop"
    "/product/etc/build.prop"
    "/system_ext/etc/build.prop"
    "/cust/build.prop"
    "/hw_product/build.prop"
    "/preload/build.prop"
    "/default.prop"
    "/prop.default"
    "/vendor/default.prop"
)

FOUND_IN_FILES=()
for f in "${PROP_FILES[@]}"; do
    result=$($ADB shell "grep -i 'model' '$f' 2>/dev/null" | tr -d '\r')
    if [ -n "$result" ]; then
        echo -e "  ${GREEN}$f${NC}"
        echo "$result" | while IFS= read -r line; do
            echo "    $line"
        done
        FOUND_IN_FILES+=("$f")
    fi
done

if [ ${#FOUND_IN_FILES[@]} -eq 0 ]; then
    warn "标准 build.prop 中未找到 model 定义"
fi

# ========== 5. 华为/鸿蒙特有路径搜索 ==========
title "5. 华为/鸿蒙特有路径搜索"

info "搜索含 model 关键字的华为特有配置..."

HW_PATHS=(
    "/cust/"
    "/hw_product/"
    "/preload/"
    "/version/"
    "/patch_hw/"
)

for p in "${HW_PATHS[@]}"; do
    result=$($ADB shell "ls '$p' 2>/dev/null" | tr -d '\r')
    if [ -n "$result" ]; then
        info "发现华为分区: $p"
        $ADB shell "find '$p' -name '*.prop' -o -name '*.cfg' -o -name '*.xml' 2>/dev/null" | tr -d '\r' | head -20 | while IFS= read -r f; do
            echo "    $f"
        done
    fi
done

# ========== 6. 搜索中文设备名（享界等） ==========
title "6. 搜索中文设备名"

info "在关键分区搜索中文设备名..."
SEARCH_RESULT=$($ADB shell "grep -rl '享界' /system/ /vendor/ /odm/ /product/ /cust/ /hw_product/ 2>/dev/null" | tr -d '\r')

if [ -n "$SEARCH_RESULT" ]; then
    info "找到包含 '享界' 的文件:"
    echo "$SEARCH_RESULT" | while IFS= read -r f; do
        echo -e "  ${RED}$f${NC}"
        $ADB shell "grep '享界' '$f' 2>/dev/null" | tr -d '\r' | while IFS= read -r line; do
            echo "    $line"
        done
    done
else
    warn "未在标准分区找到 '享界' 字样"
    info "尝试在 init 脚本中搜索..."
    $ADB shell "grep -rl 'product.model' /vendor/etc/init/ /system/etc/init/ /odm/etc/init/ 2>/dev/null" | tr -d '\r' | while IFS= read -r f; do
        echo "  init 脚本: $f"
        $ADB shell "grep 'product.model' '$f' 2>/dev/null" | tr -d '\r' | while IFS= read -r line; do
            echo "    $line"
        done
    done
fi

# ========== 7. 检查 persist 属性 ==========
title "7. 检查 persist 属性"

PERSIST_MODEL=$($ADB shell "getprop | grep -i 'persist.*model'" 2>/dev/null | tr -d '\r')
if [ -n "$PERSIST_MODEL" ]; then
    info "发现 persist model 属性:"
    echo "  $PERSIST_MODEL"
else
    info "无 persist model 覆盖"
fi

# ========== 8. 备份 ==========
title "8. 备份原始数据"

mkdir -p "$BACKUP_DIR"

info "导出全量属性..."
$ADB shell getprop > "$BACKUP_DIR/all_properties.txt" 2>/dev/null

info "备份各分区 build.prop..."
for f in "${PROP_FILES[@]}"; do
    SAFE_NAME=$(echo "$f" | tr '/' '_' | sed 's/^_//')
    $ADB shell "cat '$f' 2>/dev/null" > "$BACKUP_DIR/$SAFE_NAME" 2>/dev/null || true
    if [ -s "$BACKUP_DIR/$SAFE_NAME" ]; then
        info "  已备份: $f → $SAFE_NAME"
    else
        rm -f "$BACKUP_DIR/$SAFE_NAME"
    fi
done

info "备份所有 .prop 文件列表..."
$ADB shell "find / -name '*.prop' 2>/dev/null" > "$BACKUP_DIR/all_prop_files_list.txt" 2>/dev/null || true

# ========== 9. 输出汇总 ==========
title "9. 汇总"

echo ""
echo "  当前 Build.MODEL:  $MODEL"
echo "  备份目录:          $BACKUP_DIR/"
echo ""

ls -la "$BACKUP_DIR/" | tail -n +2 | while IFS= read -r line; do
    echo "    $line"
done

echo ""
if echo "$MODEL" | grep -P '[^\x00-\x7F]' >/dev/null 2>&1; then
    echo -e "  ${RED}[结论] Build.MODEL 含非 ASCII 字符，需要修改${NC}"
    echo ""
    echo "  修改命令（需 root）:"
    echo "    adb root"
    echo "    adb remount"
    echo "    # 找到上面标红的文件，执行 sed 替换"
    echo "    # 例: adb shell \"sed -i 's/享界S9/AITO_S9/g' <文件路径>\""
    echo "    adb reboot"
else
    echo -e "  ${GREEN}[结论] Build.MODEL 为纯 ASCII，无需修改${NC}"
fi

echo ""
info "诊断完成！"
