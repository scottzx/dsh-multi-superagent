# ModelScope Studio demo: dsh-superagent docs site.
# Listens on 0.0.0.0:7860 (required by the platform).
FROM python:3.12-slim
WORKDIR /home/user/app
COPY studio-demo/site/ /home/user/app/site/
EXPOSE 7860
CMD ["python", "-u", "-m", "http.server", "7860", "--bind", "0.0.0.0", "--directory", "/home/user/app/site"]
