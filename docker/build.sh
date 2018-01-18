docker build -t soichih/workflow ..
if [ ! $? -eq 0 ]; then
    echo "failed to build"
    exit
fi
docker tag soichih/workflow soichih/workflow:1.0.1
docker push soichih/workflow
