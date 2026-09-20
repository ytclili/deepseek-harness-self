# Agent Note: Web prompt does not identify the message channel

Status: implemented

English | [中文](2026-09-20-web-prompt-message-channel.zh.md)

## Problem

The Web bundle contributes a global prompt to its Host's agents. Describing that deployment as proof that the current user is interacting through the browser misidentifies messages delivered by another adapter on the same Host.

## Decision

The Web prompt states that the Host provides a GUI and leaves the current message's channel to trusted per-message context. The default interpretation of "this page", "this GUI", and "this app" applies only to messages received through the Web GUI. Existing URL, browser-context, build, and HMR instructions remain in the prompt.

## Alternatives considered

**Disable Web context for the whole Host.** This removes useful GUI and update instructions from actual browser conversations and cannot distinguish channels sharing one Host.

**Mark the Session as a browser conversation.** A Session can receive later messages through another adapter, so persistent channel attribution can become stale.

## Consequences

The prompt supplies deployment facts without claiming input identity. It does not implement channel authentication; adapters still own trustworthy message attribution. The focused Web bundle test checks the conditional wording and the retained update guidance; the owning Web runtime expected prompt records the complete text.
