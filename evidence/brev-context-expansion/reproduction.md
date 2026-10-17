# Reproduction

- service: target-a (container nexus-a)
- reset: `python3 -m nexus.target.manager apply a qwen25-coder-7b.tools-template`
- inject: `python3 -m nexus.target.manager apply a qwen25-coder-7b.vllm-32926`
- change between states: only the parser/template pair (hermes + model default template vs qwen2_5_coder plugin + <tools> template)
- runs: 3, all matched: True
- raw generation: deterministic replay of the identical rendered prompt at temperature 0
