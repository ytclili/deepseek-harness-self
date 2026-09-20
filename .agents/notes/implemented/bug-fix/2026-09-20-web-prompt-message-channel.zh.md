# Agent Note: Web 提示词不标识消息渠道

Status: implemented

[English](2026-09-20-web-prompt-message-channel.md) | 中文

## Problem

Web bundle 向其 Host 的 agent（智能体）提供全局提示词。将这一部署事实当作当前用户正在浏览器中交互的证明，会误判同一 Host 上由其他适配器送入的消息。

## Decision

Web 提示词说明 Host 提供 GUI，并将当前消息的渠道交由可信的逐消息上下文确定。对「this page」「this GUI」和「this app」的默认解释仅适用于经 Web GUI 接收的消息。现有 URL、浏览器上下文、构建及 HMR（热模块替换）指令保留在提示词中。

## Alternatives considered

**关闭整个 Host 的 Web 上下文。** 这会移除真实浏览器对话需要的 GUI 和更新指令，也无法区分共用同一 Host 的渠道。

**将 Session 标记为浏览器对话。** Session 后续可能从另一适配器接收消息，持久的渠道归属会因此过时。

## Consequences

提示词提供部署事实，不声明输入身份。它不实现渠道认证；适配器仍负责可信的消息归属。Web bundle 的定向测试检查限定渠道的文案及保留的更新提示；所属 Web runtime 预期提示文件记录完整文本。
