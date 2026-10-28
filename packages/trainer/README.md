# overturn-trainer

Train an open-weight model on your [Overturn](https://overturn.run) corrections **in your own cloud**, then register it so Overturn gates it against your suite, shadows it on live traffic, and lets a human promote it.

```bash
pip install 'overturn-trainer[train]'
export OVERTURN_API_KEY=ov_live_…

overturn-trainer run --base meta-llama/Llama-3.1-8B-Instruct --agent ticket-triage --out ./triage-lora
# serve ./triage-lora/adapter on vLLM (--enable-lora --lora-modules triage-lora=./triage-lora/adapter)
# point the Overturn API at it: LOCAL_MODEL_BASE_URL=http://vllm:8000/v1
overturn-trainer run … --register local/triage-lora     # or: overturn models register --base … --served-as local/triage-lora
```

Nothing but the export leaves Overturn; nothing but the registration goes back. `--backend dry` runs the whole pipeline without the ML stack (export, dataset, manifest, registration) — what CI tests.
