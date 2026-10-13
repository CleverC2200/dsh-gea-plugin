# 临时Session交付时间因果对照

原完整顺序/20轮观测仍按其冻结提交和原结果留证。此workflow不作为candidate-quality通过，仅对照首次资源Session自动打开的交付时间。原通知全部assert与per-case timeout保持原字节，生产src不变；不force click、不忽略原after失败。

context.route只暂存真实resources/select HTTP响应，保持原状态/body并forward。原ui.reload取消的旧请求将记录delivery-canceled，不当作已交付；活跃文档的真实响应在case1全部原正文检查通过后释放。随后分别50/100/200/300ms进入原清理点击，四个独立Node调用，任一失败则整体失败。全部round、原错误、卸载/点击与公开identity/Session散列保留。该小延时是因果实验变量，不是产品或测试修复，不扩大原单例deadline。

不记录Cookie/Header/正文/请求体；公开关联不代替主Session已打开证明。正式PR不含此实验。
