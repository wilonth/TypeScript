export {}

class Animal {
    constructor(public name: string) {
        this.name = name
    }
    move(meters: number) {
        console.log(this.name + " moved " + meters + "m.");
    }
}

class Snake extends Animal {
    move(meters: number) {
        console.log("Slithering...");
        super.move(meters);
    }
}

class Horse extends Animal {
    move() {
        console.log("Galloping...");
        super.move(45);
    }
}

var sam = new Snake("Sammy the Python")
var tom: Animal = new Horse("Tommy the Palomino")

sam.move(5)
tom.move(34)