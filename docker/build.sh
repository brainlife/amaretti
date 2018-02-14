tag=1.0.6
docker build -t soichih/workflow ..
if [ ! $? -eq 0 ]; then
    echo "failed to build"
    exit
fi
docker tag soichih/workflow soichih/workflow:$tag
docker push soichih/workflow:$tag
