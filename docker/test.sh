
docker run \
    --name workflow1 \
    --net test \
    -v `pwd`/config:/app/config \
    --rm -it soichih/workflow
