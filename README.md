# suva-model-image

在 Grok Bot 云端电脑本地运行的 Node.js 22+ 工具。模型推理通过魔搭 API 执行。v0.2.0 增加 JSON 配方、多图编辑、逐个 LoRA 批量和中断恢复。

## 安装与升级

在已有的工具目录运行：

    cd /workspace/suva-tools
    npm install https://github.com/Teresa1228/suva-model-image/releases/download/v0.2.0/suva-model-image-0.2.0.tgz
    npx suva-model-image doctor
    npx suva-model-image config check

用安全凭据提供 MODELSCOPE_TOKEN。已有工程仍存放在 SUVA_IMAGE_HOME 或默认的 ~/.suva-model-image。工程内保留任务、原图、配方快照与结果。安装后的 GROK.md 提供 Bot 调用规则。

## 运行

    npx suva-model-image project list
    npx suva-model-image project create "秋季上新"
    npx suva-model-image generate "海边灯塔水彩" --project "秋季上新"
    npx suva-model-image retouch ./戒指.png --prompt "保留镶爪，白底" --project "秋季上新"
    npx suva-model-image edit ./产品.png ./场景.jpg --prompt "将图一的产品放进图二的场景" --project "秋季上新" --dry-run
    npx suva-model-image models list
    npx suva-model-image loras list
    npx suva-model-image recipes list

普通生成使用 gen-default，珠宝精修使用 retouch-jewel。通用 edit 默认使用 edit-plain，原图顺序与命令行一致。每张 PNG/JPEG/WebP 限 5 MiB。加 --dry-run 只校验配置、文件和费用，打印摘要，既不联网也不创建任务。可以省略工程和 Token。

## 只改 JSON 换模型

查找顺序为 --config 文件、工程根目录旁的 $SUVA_IMAGE_HOME/models.json（默认 ~/.suva-model-image/models.json）、包内 config/default.json。自定义配置是一份完整文件。将默认配置复制到用户目录后修改，可在升级 SDK 时保留：

    mkdir -p "${SUVA_IMAGE_HOME:-$HOME/.suva-model-image}"
    cp -n node_modules/suva-model-image/config/default.json "${SUVA_IMAGE_HOME:-$HOME/.suva-model-image}/models.json"

| 配置表 | 填写内容 |
|---|---|
| models | 魔搭 ID、模型家族、支持的 generate/edit、参考图张数、尺寸白名单、是否允许 loras 字段、预估每次魔粒 cost |
| loras | 真实 LoRA ID、训练基础模型的 baseFamily、触发词 trigger、加词方式 triggerMode、提示词前缀 promptPrefix、叠加权重 |
| recipes | 单次模式、模型别名，可选 LoRA 列表、尺寸和默认提示词 |
| recipeSets | 批量模式、模型别名、有序 LoRA 列表、间隔 delayMs 和错误策略 onError |

defaults 指定默认配方、尺寸、轮询间隔和次数。命令行 --model、--lora、--size 优先于配方。已登记的 ID 和别名都能匹配家族；命令行直接传未登记的完整 ID 会显示兼容性未知。--force 只放宽已知的家族不匹配，不能覆盖禁止附加 LoRA 的模型设置。triggerMode 支持 prefix-newline、prefix、none。

若模型页示例要求把 LoRA ID 直接填入 model，把该 ID 登记在 models 中，选它作 --model 并使用没有附加 LoRA 的配方。一个附加 LoRA 按字符串发送，同一次叠加多个时用权重对象；本工具限制最多六个，权重总和等于 1。多图编辑使用 image_url 数组，读取本地原图后编码为 data URL。官方编辑示例使用公网图片 URL；具体模型是否接受 data URL 或附加 LoRA 需要用该模型实测。默认 edit-2509 禁止附加 LoRA，这是本工具的保守设置。

## 连跑 10 个 LoRA

包内 config/ten-styles.template.json 提供完整模板。先复制到自选路径，依次填入你自己的十个真实 LoRA ID、触发词及训练家族，选对应的基础模型，再把模型的 cost 填成经核实的单次估值。模板里的占位 ID 会被校验拒绝。

    npx suva-model-image config check --config ./styles.json
    npx suva-model-image batch "产品摄影，侧面柔光" --config ./styles.json --recipe-set ten-styles --project "秋季上新" --dry-run
    npx suva-model-image batch "产品摄影，侧面柔光" --config ./styles.json --recipe-set ten-styles --project "秋季上新" --max-cost 10
    npx suva-model-image resume 批次ID --project "秋季上新"

也可以用 --loras style01,style02 或重复 --lora 指定顺序，--model 更换基础模型，--recipe 选择单次配方。用 --image 图一 --image 图二给编辑批次提供原图。--delay 的单位是毫秒，默认每两项之间等待 5000 毫秒；--on-error 可选 stop 或 continue。每个 LoRA 独立提交一次，每次至多一个已知的在途任务。总估值按各子任务配置的 cost 相加；任何单价未知时显示 null，设置 --max-cost 会拒绝未知或超限计划。估值不是平台实际结算。

批次完成后，summary.json 列出每项的状态、结果路径和错误。同目录中可直接取到 01-别名.png 等编号成片。恢复使用已保存的配方快照；已成功项跳过，有魔搭任务 ID 的继续查原任务。轮询超时或下载失败时保留 ID。提交中断且没有 ID 的项标成 unknown，首次遇到会暂停；人工核实后显式 resume 可继续剩余项，不会自动重发未知项。明确限流或确认未受理的服务错误最多退避三次（15、30、60 秒）；余额不足会停止当前批次。v0.1.0 任务仍可用原本地 ID 恢复。

## SDK 与验证

generateImage({prompt,model,recipe,loras,size,config})、editImage({files,prompt,...})、retouchImage({file,prompt,...}) 返回魔搭任务 ID。getTask(id) 返回状态，成功时提供结果 URL。config 可传配置路径。运行 npm test 执行离线回归测试。

参考：[魔搭图像与编辑 API 示例](https://modelscope.csdn.net/691c36ee82fbe0098caca391.html) · [模型页的附加 LoRA 参数示例](https://www.modelscope.ai/models/openmoss/MOSS-Image-SFT) · [魔粒计费分档](https://www.modelscope.cn/posts/435591)
