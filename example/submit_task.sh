jwt=`cat ~/.sca/keys/cli.jwt`

curl \
    -H "Authorization: Bearer $jwt" \
    -H "Content-Type: application/json" \
    -X POST https://soichi7.ppa.iu.edu/api/sca/task -d '
{
    "instance_id": "5810e92adce75575985b6408",
    "service": "soichih/sca-service-noop",
    "preferred_resource_id": "579a560ec57f6be438f7d650",
    "config": {
        "test": 10000
    }
}'
