for i in mongodb-*; do
  acmongo=$i
done

echo "Using mongodb $acmongo"
cd $acmongo

mkdir testData
rm -fR testData/*

function finish {
  ./bin/mongod --shutdown --dbpath ./testData/
}
trap finish EXIT

./bin/mongod --replSet rs0 --storageEngine=mmapv1 --dbpath ./testData/ --fork --logpath ./mongodb.log 
./bin/mongo << EOC
use local
rsconf = {
   _id: "rs0",
   members: [
      {
       _id: 0,
       host: "localhost:27017"
      }
    ]
};
rs.initiate(rsconf);
EOC

tail -f ./mongodb.log






