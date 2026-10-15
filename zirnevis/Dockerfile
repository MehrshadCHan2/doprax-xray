FROM python:3.11-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Convert the Persian speech model to the fast CPU format once, while the image
# is built, so the app starts quickly. torch/transformers are removed afterwards.
ARG MODEL_REPO=givia/whisper-large-v3-turbo-persian
COPY scripts/convert_model.py scripts/
RUN pip install --no-cache-dir torch==2.14.1 --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir transformers==5.20.0 \
    && python scripts/convert_model.py "$MODEL_REPO" /models/whisper-fa \
    && pip uninstall -y torch transformers \
    && rm -rf /root/.cache

# Hugging Face Spaces run the container as user 1000.
RUN useradd -m -u 1000 user
COPY --chown=user . .
USER user

ENV ZIRNEVIS_MODEL=/models/whisper-fa \
    HF_HUB_OFFLINE=1 \
    GRADIO_ANALYTICS_ENABLED=False \
    PYTHONUNBUFFERED=1
EXPOSE 7860
CMD ["python", "app.py"]
